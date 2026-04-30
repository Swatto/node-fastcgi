import { describe, expect, it } from "vitest";
import { ProtocolError } from "../../src/errors.js";
import { decodeNameValues, encodeNameValues } from "../../src/protocol/nameValue.js";

describe("encodeNameValues / decodeNameValues round-trip", () => {
	it("encodes and decodes simple 1-byte-length pairs", () => {
		const pairs = new Map([
			["SERVER_PORT", "80"],
			["REQUEST_METHOD", "GET"],
		]);
		const buf = encodeNameValues(pairs);
		const decoded = decodeNameValues(buf);
		expect(decoded.get("SERVER_PORT")).toBe("80");
		expect(decoded.get("REQUEST_METHOD")).toBe("GET");
	});

	it("handles empty value", () => {
		const pairs = new Map([["QUERY_STRING", ""]]);
		const decoded = decodeNameValues(encodeNameValues(pairs));
		expect(decoded.get("QUERY_STRING")).toBe("");
	});

	it("handles empty name-value set (zero bytes)", () => {
		const decoded = decodeNameValues(Buffer.alloc(0));
		expect(decoded.size).toBe(0);
	});

	it("handles a value longer than 127 bytes (4-byte value length)", () => {
		const longValue = "x".repeat(200);
		const pairs = new Map([["LONG_PARAM", longValue]]);
		const buf = encodeNameValues(pairs);
		const decoded = decodeNameValues(buf);
		expect(decoded.get("LONG_PARAM")).toBe(longValue);
	});

	it("handles a name longer than 127 bytes (4-byte name length)", () => {
		const longName = "A".repeat(130);
		const pairs = new Map([[longName, "val"]]);
		const buf = encodeNameValues(pairs);
		const decoded = decodeNameValues(buf);
		expect(decoded.get(longName)).toBe("val");
	});

	it("handles both name and value longer than 127 bytes", () => {
		const longName = "N".repeat(200);
		const longValue = "V".repeat(200);
		const pairs = new Map([[longName, longValue]]);
		const decoded = decodeNameValues(encodeNameValues(pairs));
		expect(decoded.get(longName)).toBe(longValue);
	});

	it("preserves multiple pairs with unicode content", () => {
		const pairs = { HTTP_ACCEPT: "text/html", HTTP_X_CUSTOM: "héllo" };
		const decoded = decodeNameValues(encodeNameValues(pairs));
		expect(decoded.get("HTTP_ACCEPT")).toBe("text/html");
		expect(decoded.get("HTTP_X_CUSTOM")).toBe("héllo");
	});

	it("uses 1-byte encoding for lengths exactly 127", () => {
		const name = "K".repeat(127);
		const value = "V".repeat(127);
		const buf = encodeNameValues(new Map([[name, value]]));
		// First byte should be 0x7F (127, high bit = 0)
		expect(buf[0]).toBe(127);
		expect(buf[1]).toBe(127);
	});

	it("uses 4-byte encoding for lengths exactly 128", () => {
		const name = "K".repeat(128);
		const buf = encodeNameValues(new Map([[name, ""]]));
		// First byte high bit should be set
		expect(((buf[0] ?? 0) & 0x80) !== 0).toBe(true);
	});

	it("decodeNameValues rejects oversized declared length", () => {
		const buf = Buffer.concat([
			Buffer.from([0x80, 0, 0, 0x64]),
			Buffer.from([0x01]),
			Buffer.from([0x41, 0x41, 0x41]),
		]);
		expect(() => decodeNameValues(buf)).toThrow(ProtocolError);
	});
});
