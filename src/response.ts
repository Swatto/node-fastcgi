/**
 * Writes a Web-standard `Response` back to the web server as FastCGI records.
 *
 * CGI parsed-header convention (spec sec 6.1, 6.2):
 *   - First STDOUT data: "Status: <code> <reason>\r\n" + headers + "\r\n"
 *   - Then: streaming body chunks as FCGI_STDOUT records (max 65535 bytes each)
 *   - Then: empty FCGI_STDOUT (stream terminator)
 *   - Then: FCGI_END_REQUEST { appStatus, protocolStatus: REQUEST_COMPLETE }
 *   - STDERR: emitted only if there is error content (no empty terminator otherwise)
 *
 * Backpressure: we await socket drain before writing if socket.write() returns false.
 */

import { STATUS_CODES } from "node:http";
import type { Socket } from "node:net";
import type { FcgiConnection, RequestState } from "./protocol/connection.js";
import { FCGI_HEADER_LEN, FCGI_VERSION_1, ProtocolStatus, RecordType } from "./protocol/constants.js";

/** Max content bytes in a single FCGI_STDOUT record. */
const MAX_CONTENT_LENGTH = 65535;

/**
 * Write a Web `Response` as FastCGI STDOUT/END_REQUEST records to `socket`.
 *
 * Returns a Promise that resolves when `END_REQUEST` has been fully written.
 * Calls `conn.sendEndRequest` as the final step unless `state.ended` becomes true
 * after an interrupt (e.g. ABORT_REQUEST), in which case END was already sent.
 */
export async function writeResponse(
	response: Response,
	requestId: number,
	appStatus: number,
	socket: Socket,
	conn: FcgiConnection,
	state: RequestState,
): Promise<void> {
	// ------------------------------------------------------------------
	// Build the CGI response header block
	// ------------------------------------------------------------------
	const headerLines: string[] = [];

	const rawStatusText = response.statusText || STATUS_CODES[response.status] || "Unknown";
	// RFC 9110 Field values — strip CRLF and C0 controls to prevent response splitting.
	const statusText = stripCTL(rawStatusText);
	headerLines.push(`Status: ${response.status} ${statusText}`);

	// Emit Set-Cookie headers separately (they can't be merged into one line).
	const setCookies = response.headers.getSetCookie();

	for (const [name, value] of response.headers.entries()) {
		if (name.toLowerCase() === "set-cookie") continue; // emitted separately below
		headerLines.push(`${stripCTL(name)}: ${stripCTL(value)}`);
	}
	for (const cookie of setCookies) {
		headerLines.push(`set-cookie: ${stripCTL(cookie)}`);
	}

	headerLines.push(""); // blank line separates headers from body
	const headerBlock = Buffer.from(`${headerLines.join("\r\n")}\r\n`, "utf8");

	// ------------------------------------------------------------------
	// Write headers as first STDOUT chunk(s)
	// ------------------------------------------------------------------
	await writeChunked(socket, requestId, headerBlock);
	if (state.ended) return;

	// ------------------------------------------------------------------
	// Write body
	// ------------------------------------------------------------------
	if (response.body) {
		const reader = response.body.getReader();
		let abortReason: unknown;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (state.ended) {
					abortReason = new Error("Request ended before response body was fully written");
					break;
				}
				if (done) break;
				if (value && value.length > 0) {
					await writeChunked(socket, requestId, Buffer.from(value));
					if (state.ended) {
						abortReason = new Error("Request ended before response body was fully written");
						break;
					}
				}
			}
		} catch (err) {
			abortReason = err;
			throw err;
		} finally {
			if (abortReason !== undefined) {
				try {
					await reader.cancel(abortReason as Error);
				} catch {
					// ignore — we're already in a teardown path
				}
			}
			reader.releaseLock();
		}
		if (state.ended) return;
	}

	if (state.ended) return;

	// ------------------------------------------------------------------
	// Empty STDOUT to terminate the stream (spec sec 6.1)
	// An empty record has zero content and zero padding: exactly 8 bytes.
	// ------------------------------------------------------------------
	const emptyStdout = Buffer.allocUnsafe(FCGI_HEADER_LEN);
	emptyStdout[0] = FCGI_VERSION_1;
	emptyStdout[1] = RecordType.STDOUT;
	emptyStdout.writeUInt16BE(requestId, 2);
	emptyStdout.writeUInt16BE(0, 4); // contentLength = 0
	emptyStdout[6] = 0; // paddingLength = 0
	emptyStdout[7] = 0; // reserved
	await socketWrite(socket, emptyStdout);
	if (state.ended) return;

	// ------------------------------------------------------------------
	// END_REQUEST
	// ------------------------------------------------------------------
	conn.sendEndRequest(requestId, appStatus, ProtocolStatus.REQUEST_COMPLETE);
}

/**
 * Write an error diagnostic to FCGI_STDERR (spec sec 6.1).
 * STDERR has no empty-record terminator when there is nothing to write,
 * but when we do write, we send one to formally close the stream.
 */
export async function writeStderr(
	socket: Socket,
	requestId: number,
	message: string,
): Promise<void> {
	if (message.length === 0) return; // honor "no terminator when nothing to write"
	const data = Buffer.from(message, "utf8");
	await writeChunked(socket, requestId, data, RecordType.STDERR);
	const emptyStderr = Buffer.allocUnsafe(FCGI_HEADER_LEN);
	emptyStderr[0] = FCGI_VERSION_1;
	emptyStderr[1] = RecordType.STDERR;
	emptyStderr.writeUInt16BE(requestId, 2);
	emptyStderr.writeUInt16BE(0, 4);
	emptyStderr[6] = 0;
	emptyStderr[7] = 0;
	await socketWrite(socket, emptyStderr);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split `data` into FCGI records of at most MAX_CONTENT_LENGTH bytes and write
 * them to `socket` without copying content into an intermediate record Buffer.
 *
 * Each record is written as two consecutive socket.write() calls:
 *   1. An 8-byte record header (fresh 8-byte Buffer per chunk — never the content size)
 *   2. The content slice (zero-copy subarray of `data`)
 *
 * The main saving over encodeRecord() is that content bytes are never copied into
 * a combined buffer — they flow from `data` directly to the socket write queue.
 * Node.js's internal stream buffering batches the two writes efficiently.
 *
 * Backpressure is signalled by the content write (the larger of the two), which
 * is awaited via socketWrite. The header write (8 bytes) is fire-and-forget;
 * any error it produces is surfaced via the socket's 'error' event.
 */
async function writeChunked(
	socket: Socket,
	requestId: number,
	data: Buffer,
	type: RecordType = RecordType.STDOUT,
): Promise<void> {
	if (data.length === 0) return;

	let offset = 0;
	while (offset < data.length) {
		const slice = data.subarray(offset, offset + MAX_CONTENT_LENGTH);

		// Fresh 8-byte header per chunk — socket.write() keeps a reference and does
		// not copy immediately, so reusing a single buffer across iterations under
		// backpressure would corrupt queued data.
		const hdr = Buffer.allocUnsafe(FCGI_HEADER_LEN);
		hdr[0] = FCGI_VERSION_1;
		hdr[1] = type;
		hdr.writeUInt16BE(requestId, 2);
		hdr.writeUInt16BE(slice.length, 4);
		hdr[6] = 0; // paddingLength = 0 (spec: "need not be padded")
		hdr[7] = 0; // reserved

		socket.write(hdr);
		await socketWrite(socket, slice);

		offset += slice.length;
	}
}

function stripCTL(value: string): string {
	// Fast path: scan for CTL chars before allocating anything.
	// In production header values never contain CTL chars, so this returns the
	// original string reference with zero allocation in the common case.
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c <= 8 || (c >= 10 && c <= 31) || c === 127) {
			// Slow path: strip CR, LF, NUL, C0 controls (except HT \t = 9), and DEL.
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping CTL chars is the intent
			return value.replace(/[\x00-\x08\x0a-\x1f\x7f]/g, "");
		}
	}
	return value;
}

/** Write a buffer to the socket, waiting for drain if backpressure applies. */
function socketWrite(socket: Socket, buf: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		if (socket.destroyed) {
			reject(new Error("Socket destroyed"));
			return;
		}
		const ok = socket.write(buf, (err) => {
			if (err) reject(err);
			else resolve();
		});
		// If ok === false the data was buffered; the callback still fires when flushed.
		// We rely on the callback rather than the drain event for simplicity, but the
		// callback is called either way (after drain when buffered).
		void ok;
	});
}
