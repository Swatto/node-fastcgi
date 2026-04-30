import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { RecordType } from "../../src/protocol/constants.js";
import { writeStderr } from "../../src/response.js";

function fakeSocket(): { socket: Socket; chunks: Buffer[] } {
	const chunks: Buffer[] = [];
	const socket = {
		destroyed: false,
		write(buf: Buffer, cb: (err?: Error | null) => void) {
			chunks.push(buf);
			queueMicrotask(() => cb(null));
			return true;
		},
	} as unknown as Socket;
	return { socket, chunks };
}

describe("writeStderr", () => {
	it("emits no records for an empty message", async () => {
		const { socket, chunks } = fakeSocket();
		await writeStderr(socket, 1, "");
		expect(chunks).toHaveLength(0);
	});

	it("emits content + terminator for a non-empty message", async () => {
		const { socket, chunks } = fakeSocket();
		await writeStderr(socket, 7, "boom");
		// Concatenate all written chunks and parse the records
		const all = Buffer.concat(chunks);
		// Should contain at least 2 records: data + empty terminator
		// Both should be type=STDERR (7) and requestId=7
		const stderrType = RecordType.STDERR;
		let offset = 0;
		const records: Array<{ type: number; requestId: number; contentLen: number }> = [];
		while (offset < all.length) {
			const type = all[offset + 1];
			const requestId = all.readUInt16BE(offset + 2);
			const contentLen = all.readUInt16BE(offset + 4);
			const paddingLen = all[offset + 6] ?? 0;
			records.push({ type: type ?? 0, requestId, contentLen });
			offset += 8 + contentLen + paddingLen;
		}
		expect(records.length).toBe(2);
		expect(records[0]?.type).toBe(stderrType);
		expect(records[0]?.requestId).toBe(7);
		expect(records[0]?.contentLen).toBe(4);
		expect(records[1]?.type).toBe(stderrType);
		expect(records[1]?.requestId).toBe(7);
		expect(records[1]?.contentLen).toBe(0);
	});
});
