import { ProtocolError } from "../errors.js";

/**
 * FastCGI name-value pair encoding/decoding (spec section 3.4).
 *
 * Each length is encoded as:
 *   - 1 byte  when value is 0..127  (high bit = 0)
 *   - 4 bytes when value is 128+    (high bit of first byte = 1, remaining
 *                                    31 bits hold the length)
 *
 * The four resulting struct shapes are:
 *   FCGI_NameValuePair11 (1-byte name len, 1-byte value len)
 *   FCGI_NameValuePair14 (1-byte name len, 4-byte value len)
 *   FCGI_NameValuePair41 (4-byte name len, 1-byte value len)
 *   FCGI_NameValuePair44 (4-byte name len, 4-byte value len)
 */

/** Encode a map of name/value pairs into a Buffer suitable for FCGI_PARAMS or FCGI_GET_VALUES_RESULT. */
export function encodeNameValues(pairs: Map<string, string> | Record<string, string>): Buffer {
	const entries = pairs instanceof Map ? [...pairs.entries()] : Object.entries(pairs);

	const parts: Buffer[] = [];
	for (const [name, value] of entries) {
		const nameBytes = Buffer.from(name, "utf8");
		const valueBytes = Buffer.from(value, "utf8");
		parts.push(encodeLength(nameBytes.length));
		parts.push(encodeLength(valueBytes.length));
		parts.push(nameBytes);
		parts.push(valueBytes);
	}
	return Buffer.concat(parts);
}

/**
 * Decode all name-value pairs from a Buffer (e.g. the contentData of FCGI_PARAMS).
 *
 * - When `into` is provided, pairs are accumulated directly into that Map and the
 *   same Map is returned — avoids allocating a temporary Map and a merge loop at
 *   the call site.
 * - When `onEachPair` is provided, it is called for every decoded pair (after the
 *   pair has been added to `into`). This allows a single decode pass to populate
 *   multiple data structures (e.g. params Map + HTTP headers object) without
 *   iterating the buffer twice.
 */
export function decodeNameValues(
	buf: Buffer,
	into?: Map<string, string>,
	onEachPair?: (name: string, value: string) => void,
): Map<string, string> {
	const result = into ?? new Map<string, string>();
	let offset = 0;

	while (offset < buf.length) {
		const { length: nameLen, bytesRead: nb } = decodeLength(buf, offset);
		offset += nb;
		const { length: valueLen, bytesRead: vb } = decodeLength(buf, offset);
		offset += vb;

		if (offset + nameLen > buf.length) {
			throw new ProtocolError(
				`decodeNameValues: name length ${nameLen} exceeds buffer at offset ${offset}`,
			);
		}
		const name = buf.subarray(offset, offset + nameLen).toString("utf8");
		offset += nameLen;

		if (offset + valueLen > buf.length) {
			throw new ProtocolError(
				`decodeNameValues: value length ${valueLen} exceeds buffer at offset ${offset}`,
			);
		}
		const value = buf.subarray(offset, offset + valueLen).toString("utf8");
		offset += valueLen;

		result.set(name, value);
		onEachPair?.(name, value);
	}

	return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function encodeLength(len: number): Buffer {
	if (len <= 127) {
		const b = Buffer.allocUnsafe(1);
		b[0] = len;
		return b;
	}
	const b = Buffer.allocUnsafe(4);
	// Set the high bit to signal a 4-byte length, then mask off that bit before
	// storing the actual length value into the lower 31 bits.
	b[0] = ((len >>> 24) & 0x7f) | 0x80;
	b[1] = (len >>> 16) & 0xff;
	b[2] = (len >>> 8) & 0xff;
	b[3] = len & 0xff;
	return b;
}

function decodeLength(buf: Buffer, offset: number): { length: number; bytesRead: number } {
	const first = buf[offset];
	if (first === undefined) {
		throw new ProtocolError(`decodeLength: buffer underrun at offset ${offset}`);
	}
	if ((first & 0x80) === 0) {
		return { length: first, bytesRead: 1 };
	}
	if (offset + 4 > buf.length) {
		throw new ProtocolError(`decodeLength: not enough bytes for 4-byte length at offset ${offset}`);
	}
	const length = buf.readUInt32BE(offset) & 0x7fffffff;
	return { length, bytesRead: 4 };
}
