/**
 * FastCGI record header encode/decode and streaming parser.
 *
 * Record layout (spec section 3.3):
 *   Byte 0: version
 *   Byte 1: type
 *   Bytes 2-3: requestId (big-endian)
 *   Bytes 4-5: contentLength (big-endian, 0..65535)
 *   Byte 6: paddingLength (0..255)
 *   Byte 7: reserved
 *   Bytes 8..(8+contentLength): contentData
 *   Following bytes: paddingData (paddingLength bytes, ignored)
 *
 * Recommended alignment: pad records so total length is a multiple of 8.
 */

import { ProtocolError } from "../errors.js";
import type { RecordType } from "./constants.js";
import { FCGI_HEADER_LEN, FCGI_VERSION_1 } from "./constants.js";

/** Parsed representation of a single FastCGI record. */
export interface FcgiRecord {
	version: number;
	type: RecordType;
	requestId: number;
	contentData: Buffer;
}

/** Encode a FastCGI record into a Buffer, padding to an 8-byte boundary. */
export function encodeRecord(
	type: RecordType,
	requestId: number,
	content: Buffer | Uint8Array,
): Buffer {
	const contentLength = content.length;
	// Padding to align (header + content) to a multiple of 8.
	const unpadded = FCGI_HEADER_LEN + contentLength;
	const paddingLength = (8 - (unpadded % 8)) % 8;
	const total = unpadded + paddingLength;

	const buf = Buffer.allocUnsafe(total);
	buf[0] = FCGI_VERSION_1;
	buf[1] = type;
	buf.writeUInt16BE(requestId, 2);
	buf.writeUInt16BE(contentLength, 4);
	buf[6] = paddingLength;
	buf[7] = 0; // reserved

	if (contentLength > 0) {
		if (Buffer.isBuffer(content)) {
			content.copy(buf, FCGI_HEADER_LEN);
		} else {
			buf.set(content, FCGI_HEADER_LEN);
		}
	}
	// Padding bytes are left as-is (allocUnsafe is fine; they're ignored by receiver).
	return buf;
}

// ---------------------------------------------------------------------------
// Streaming record parser
// ---------------------------------------------------------------------------

type RecordCallback = (record: FcgiRecord) => void;

/**
 * Stateful parser that reassembles FastCGI records from a stream of raw
 * Buffer chunks (e.g. from a TCP socket's `data` events).
 *
 * Uses a chunk list instead of concatenating every `push`, so fragmented TCP
 * segments do not incur O(n²) buffer copies; full buffers are materialised only
 * when a read crosses a chunk boundary.
 *
 * Usage:
 *   const parser = new RecordParser((record) => { ... });
 *   socket.on('data', (chunk) => parser.push(chunk));
 */
export class RecordParser {
	private readonly onRecord: RecordCallback;

	/** Pending input chunks, consumed from the front. */
	private chunks: Buffer[] = [];
	/** Total unread bytes across all chunks (minus chunkOffset into chunks[0]). */
	private totalBytes = 0;
	/** Read offset into chunks[0]. */
	private chunkOffset = 0;

	// Parser state
	private state: "header" | "body" = "header";
	private currentType: RecordType = 1 as RecordType;
	private currentRequestId = 0;
	private currentContentLength = 0;
	private currentPaddingLength = 0;

	constructor(onRecord: RecordCallback) {
		this.onRecord = onRecord;
	}

	push(chunk: Buffer): void {
		if (chunk.length > 0) {
			this.chunks.push(chunk);
			this.totalBytes += chunk.length;
		}
		this.drain();
	}

	/**
	 * Read exactly `n` bytes from the front of the chunk list.
	 * Returns a zero-copy subarray when the bytes live in a single chunk,
	 * or a freshly allocated Buffer when they span multiple chunks.
	 * Caller must copy the result if it needs to outlive subsequent pushes.
	 */
	private readBytes(n: number): Buffer {
		if (n === 0) return Buffer.allocUnsafe(0);

		const first = this.chunks[0];
		if (first === undefined) throw new ProtocolError("readBytes: buffer underrun");

		const avail = first.length - this.chunkOffset;
		if (n <= avail) {
			// Fast path: all bytes in the current chunk — zero-copy subarray
			const slice = first.subarray(this.chunkOffset, this.chunkOffset + n);
			this.chunkOffset += n;
			this.totalBytes -= n;
			if (this.chunkOffset === first.length) {
				this.chunks.shift();
				this.chunkOffset = 0;
			}
			return slice;
		}

		// Slow path: spans multiple chunks — allocate and copy
		const result = Buffer.allocUnsafe(n);
		let written = 0;
		let remaining = n;
		while (remaining > 0) {
			const chunk = this.chunks[0];
			if (chunk === undefined) throw new ProtocolError("readBytes: buffer underrun");
			const chunkAvail = chunk.length - this.chunkOffset;
			const take = Math.min(chunkAvail, remaining);
			chunk.copy(result, written, this.chunkOffset, this.chunkOffset + take);
			written += take;
			remaining -= take;
			this.totalBytes -= take;
			this.chunkOffset += take;
			if (this.chunkOffset === chunk.length) {
				this.chunks.shift();
				this.chunkOffset = 0;
			}
		}
		return result;
	}

	/** Discard `n` bytes from the front of the chunk list (padding). */
	private skipBytes(n: number): void {
		let remaining = n;
		while (remaining > 0) {
			const chunk = this.chunks[0];
			if (chunk === undefined) break;
			const avail = chunk.length - this.chunkOffset;
			const skip = Math.min(avail, remaining);
			remaining -= skip;
			this.totalBytes -= skip;
			this.chunkOffset += skip;
			if (this.chunkOffset === chunk.length) {
				this.chunks.shift();
				this.chunkOffset = 0;
			}
		}
	}

	private drain(): void {
		while (true) {
			if (this.state === "header") {
				if (this.totalBytes < FCGI_HEADER_LEN) return;

				const header = this.readBytes(FCGI_HEADER_LEN);
				if (header[0] !== FCGI_VERSION_1) {
					throw new ProtocolError(
						`Unsupported FastCGI version: ${header[0]} (expected ${FCGI_VERSION_1})`,
					);
				}
				this.currentType = header[1] as RecordType;
				this.currentRequestId = header.readUInt16BE(2);
				this.currentContentLength = header.readUInt16BE(4);
				this.currentPaddingLength = header[6] as number;
				this.state = "body";
			}

			if (this.state === "body") {
				const needed = this.currentContentLength + this.currentPaddingLength;
				if (this.totalBytes < needed) return;

				// Always copy contentData so callers can safely retain a reference
				const contentData = Buffer.from(this.readBytes(this.currentContentLength));
				this.skipBytes(this.currentPaddingLength);
				this.state = "header";

				this.onRecord({
					version: FCGI_VERSION_1,
					type: this.currentType,
					requestId: this.currentRequestId,
					contentData,
				});
			}
		}
	}

	/** How many unprocessed bytes remain in the internal buffer. */
	get bufferedBytes(): number {
		return this.totalBytes;
	}
}
