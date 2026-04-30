import { describe, expect, it } from "vitest";
import { ProtocolError } from "../../src/errors.js";
import { FCGI_HEADER_LEN, FCGI_VERSION_1, RecordType } from "../../src/protocol/constants.js";
import { encodeRecord, RecordParser } from "../../src/protocol/record.js";

describe("encodeRecord", () => {
	it("writes the 8-byte header correctly", () => {
		const content = Buffer.from("hello");
		const buf = encodeRecord(RecordType.STDOUT, 3, content);

		expect(buf[0]).toBe(FCGI_VERSION_1);
		expect(buf[1]).toBe(RecordType.STDOUT);
		expect(buf.readUInt16BE(2)).toBe(3); // requestId
		expect(buf.readUInt16BE(4)).toBe(5); // contentLength
	});

	it("pads the record to a multiple of 8 bytes", () => {
		// header (8) + content (5) = 13 → padded to 16
		const buf = encodeRecord(RecordType.STDOUT, 1, Buffer.from("hello"));
		expect(buf.length % 8).toBe(0);
		expect(buf.length).toBe(16);
	});

	it("produces no padding for content aligned to 8 bytes", () => {
		// header (8) + content (8) = 16 → no padding needed
		const buf = encodeRecord(RecordType.STDOUT, 1, Buffer.alloc(8));
		expect(buf.length).toBe(16);
		expect(buf[6]).toBe(0); // paddingLength
	});

	it("handles empty content (empty stream terminator)", () => {
		const buf = encodeRecord(RecordType.STDOUT, 1, Buffer.alloc(0));
		expect(buf.length).toBe(FCGI_HEADER_LEN);
		expect(buf.readUInt16BE(4)).toBe(0); // contentLength
		expect(buf[6]).toBe(0); // paddingLength
	});

	it("sets the correct paddingLength byte", () => {
		// header (8) + content (1) = 9 → padding = 7 to reach 16
		const buf = encodeRecord(RecordType.STDOUT, 1, Buffer.alloc(1));
		expect(buf[6]).toBe(7);
		expect(buf.length).toBe(16);
	});
});

describe("RecordParser", () => {
	function collectRecords(chunks: Buffer[]) {
		const records: Array<{ type: number; requestId: number; content: Buffer }> = [];
		const parser = new RecordParser((rec) => {
			records.push({ type: rec.type, requestId: rec.requestId, content: rec.contentData });
		});
		for (const chunk of chunks) {
			parser.push(chunk);
		}
		return records;
	}

	it("parses a single record delivered all at once", () => {
		const content = Buffer.from("test-body");
		const wire = encodeRecord(RecordType.STDIN, 5, content);
		const records = collectRecords([wire]);

		expect(records).toHaveLength(1);
		expect(records[0]?.type).toBe(RecordType.STDIN);
		expect(records[0]?.requestId).toBe(5);
		expect(records[0]?.content.toString()).toBe("test-body");
	});

	it("parses a record delivered byte-by-byte", () => {
		const wire = encodeRecord(RecordType.PARAMS, 1, Buffer.from("key=value"));
		const chunks = Array.from({ length: wire.length }, (_, i) => wire.subarray(i, i + 1));
		const records = collectRecords(chunks);

		expect(records).toHaveLength(1);
		expect(records[0]?.content.toString()).toBe("key=value");
	});

	it("parses multiple records from a single chunk", () => {
		const rec1 = encodeRecord(RecordType.PARAMS, 1, Buffer.from("a=1"));
		const rec2 = encodeRecord(RecordType.PARAMS, 1, Buffer.alloc(0)); // empty terminator
		const combined = Buffer.concat([rec1, rec2]);
		const records = collectRecords([combined]);

		expect(records).toHaveLength(2);
		expect(records[0]?.content.toString()).toBe("a=1");
		expect(records[1]?.content.length).toBe(0);
	});

	it("handles split across header/body boundary", () => {
		const wire = encodeRecord(RecordType.STDOUT, 2, Buffer.from("response-data"));
		// Split in the middle of the header
		const chunks = [wire.subarray(0, 3), wire.subarray(3)];
		const records = collectRecords(chunks);

		expect(records).toHaveLength(1);
		expect(records[0]?.content.toString()).toBe("response-data");
	});

	it("skips paddingData correctly", () => {
		// header (8) + content (3) = 11 → padding = 5 to reach 16
		const wire = encodeRecord(RecordType.STDOUT, 1, Buffer.from("abc"));
		expect(wire[6]).toBe(5); // verify padding
		const records = collectRecords([wire]);
		expect(records[0]?.content.toString()).toBe("abc");
	});

	it("tracks bufferedBytes correctly", () => {
		const parser = new RecordParser(() => {});
		const wire = encodeRecord(RecordType.STDOUT, 1, Buffer.from("hello"));
		// Push only half
		parser.push(wire.subarray(0, 4));
		expect(parser.bufferedBytes).toBe(4);
		// Push rest
		parser.push(wire.subarray(4));
		expect(parser.bufferedBytes).toBe(0);
	});
});

describe("RecordParser maxBufferedBytes", () => {
	it("default cap is 8 MiB", () => {
		const parser = new RecordParser(() => {});
		const big = Buffer.alloc(8 * 1024 * 1024 + 1, 0);
		expect(() => parser.push(big)).toThrow(ProtocolError);
	});

	it("honors a custom maxBufferedBytes (strict > cap)", () => {
		const parser = new RecordParser(() => {}, { maxBufferedBytes: 4 });
		parser.push(Buffer.alloc(2));
		parser.push(Buffer.alloc(2));
		expect(() => parser.push(Buffer.from([0]))).toThrow(ProtocolError);
	});

	it("re-allows pushes after a complete record drains below the cap", () => {
		const parser = new RecordParser(() => {}, { maxBufferedBytes: 16 });
		const first = encodeRecord(RecordType.STDOUT, 1, Buffer.from("x"));
		parser.push(first);
		expect(parser.bufferedBytes).toBe(0);

		const tiny = encodeRecord(RecordType.STDOUT, 1, Buffer.alloc(0));
		expect(tiny.length).toBe(FCGI_HEADER_LEN);

		parser.push(tiny.subarray(0, 7));
		expect(parser.bufferedBytes).toBe(7);
		parser.push(tiny.subarray(7));
		expect(parser.bufferedBytes).toBe(0);

		parser.push(tiny.subarray(0, 7));
		expect(() => parser.push(Buffer.alloc(10))).toThrow(ProtocolError);
	});
});
