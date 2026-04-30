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
import { ProtocolStatus, RecordType } from "./protocol/constants.js";
import { encodeRecord } from "./protocol/record.js";

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
	// ------------------------------------------------------------------
	await socketWrite(socket, encodeRecord(RecordType.STDOUT, requestId, Buffer.alloc(0)));
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
	await socketWrite(socket, encodeRecord(RecordType.STDERR, requestId, Buffer.alloc(0)));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split `data` into FCGI records of at most MAX_CONTENT_LENGTH bytes. */
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
		await socketWrite(socket, encodeRecord(type, requestId, slice));
		offset += slice.length;
	}
}

function stripCTL(value: string): string {
	// Strip CR, LF, NUL, all C0 controls except HT (\t), and DEL.
	return [...value]
		.filter((ch) => {
			const c = ch.codePointAt(0) ?? 0;
			if (c <= 8) return false;
			if (c >= 10 && c <= 31) return false;
			if (c === 127) return false;
			return true;
		})
		.join("");
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
