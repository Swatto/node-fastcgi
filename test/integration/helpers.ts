/**
 * Shared FastCGI wire-protocol helpers for integration tests.
 *
 * Each test file spins up its own serve() listener; these utilities handle
 * encoding raw FastCGI bytes and decoding the server's response.
 */

import * as net from "node:net";
import {
	FCGI_MAX_CONNS,
	FCGI_MAX_REQS,
	FCGI_MPXS_CONNS,
	RecordType,
	Role,
} from "../../src/protocol/constants.js";
import { encodeNameValues } from "../../src/protocol/nameValue.js";
import type { FcgiRecord } from "../../src/protocol/record.js";
import { encodeRecord, RecordParser } from "../../src/protocol/record.js";

export type { FcgiRecord };
export { FCGI_MAX_CONNS, FCGI_MAX_REQS, FCGI_MPXS_CONNS, RecordParser, RecordType, Role };

// ---------------------------------------------------------------------------
// Record builders
// ---------------------------------------------------------------------------

/** Build a FCGI_BEGIN_REQUEST record. */
export function beginRequest(requestId: number, role: number, flags = 0): Buffer {
	const body = Buffer.alloc(8);
	body.writeUInt16BE(role, 0);
	body[2] = flags;
	return encodeRecord(RecordType.BEGIN_REQUEST, requestId, body);
}

/** Build a single FCGI_PARAMS record from a plain object. */
export function paramsRecord(requestId: number, params: Record<string, string>): Buffer {
	return encodeRecord(RecordType.PARAMS, requestId, encodeNameValues(params));
}

/** Build an empty terminator record for any stream type. */
export function emptyRecord(type: RecordType, requestId: number): Buffer {
	return encodeRecord(type, requestId, Buffer.alloc(0));
}

/** Build a FCGI_STDIN record with UTF-8 body content. */
export function stdinRecord(requestId: number, content: string): Buffer {
	return encodeRecord(RecordType.STDIN, requestId, Buffer.from(content, "utf8"));
}

/** Build a FCGI_GET_VALUES record querying all three standard variables. */
export function getValuesRecord(): Buffer {
	const query = encodeNameValues({
		[FCGI_MAX_CONNS]: "",
		[FCGI_MAX_REQS]: "",
		[FCGI_MPXS_CONNS]: "",
	});
	return encodeRecord(RecordType.GET_VALUES, 0, query);
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

/**
 * Connect to `port`, send `data`, collect all records until the socket closes,
 * then resolve with the list.
 *
 * If `options.resolveWhen` is set, the client calls it for each parsed record and
 * resolves (and destroys the socket) as soon as it returns true — useful when the
 * server keeps the connection open after a management record such as GET_VALUES_RESULT.
 */
export function sendAndCollect(
	port: number,
	data: Buffer,
	options?: { resolveWhen?: (record: FcgiRecord) => boolean },
): Promise<FcgiRecord[]> {
	return new Promise((resolve, reject) => {
		const records: FcgiRecord[] = [];
		let settled = false;
		let socket!: net.Socket;
		let timer!: NodeJS.Timeout;

		const settleResolve = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(records);
		};

		const settleReject = (err: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		};

		const parser = new RecordParser((r) => {
			records.push(r);
			if (options?.resolveWhen?.(r)) {
				settleResolve();
				socket.destroy();
			}
		});

		socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
			socket.write(data);
		});
		socket.on("data", (chunk: Buffer) => parser.push(chunk));
		socket.on("end", () => settleResolve());
		socket.on("error", (err) => settleReject(err));
		timer = setTimeout(() => {
			socket.destroy();
			settleReject(new Error("Timeout"));
		}, 5000);
	});
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** Parse the STDOUT content as a CGI response, returning { status, headers, body }. */
export function parseCgiResponse(stdoutContent: Buffer): {
	status: number;
	headers: Record<string, string>;
	body: string;
} {
	const text = stdoutContent.toString("utf8");
	const [headerSection, ...bodyParts] = text.split("\r\n\r\n");
	const body = bodyParts.join("\r\n\r\n");

	const lines = (headerSection ?? "").split("\r\n");
	const headers: Record<string, string> = {};
	let status = 200;

	for (const line of lines) {
		const colon = line.indexOf(": ");
		if (colon === -1) continue;
		const name = line.slice(0, colon).toLowerCase();
		const value = line.slice(colon + 2);
		if (name === "status") {
			status = parseInt(value, 10);
		} else {
			headers[name] = value;
		}
	}

	return { status, headers, body };
}

// ---------------------------------------------------------------------------
// Convenience: send a single GET or POST and return the parsed CGI response
// ---------------------------------------------------------------------------

export interface SimpleRequestOptions {
	port: number;
	method?: string;
	path: string;
	host?: string;
	headers?: Record<string, string>;
	/** Body as a UTF-8 string (for POST/PUT). */
	body?: string;
}

/**
 * Send a single FastCGI request and return the parsed CGI response.
 * Handles the full BEGIN_REQUEST → PARAMS → STDIN sequence.
 *
 * `content-type` is mapped to the `CONTENT_TYPE` CGI variable (not HTTP_*),
 * matching RFC 3875 §4.1.3 and the library's request.ts implementation.
 */
export async function fcgiRequest(opts: SimpleRequestOptions): Promise<{
	status: number;
	headers: Record<string, string>;
	body: string;
}> {
	const method = opts.method ?? "GET";
	const host = opts.host ?? `localhost:${opts.port}`;
	const extraHeaders = opts.headers ?? {};

	const params: Record<string, string> = {
		REQUEST_METHOD: method,
		REQUEST_URI: opts.path,
		HTTP_HOST: host,
		SERVER_NAME: host.split(":")[0] ?? "localhost",
		SERVER_PORT: String(opts.port),
	};

	for (const [key, value] of Object.entries(extraHeaders)) {
		const lower = key.toLowerCase();
		if (lower === "content-type") {
			// RFC 3875: CONTENT_TYPE is a direct CGI variable, not HTTP_CONTENT_TYPE
			params.CONTENT_TYPE = value;
		} else {
			params[`HTTP_${key.toUpperCase().replaceAll("-", "_")}`] = value;
		}
	}

	if (opts.body !== undefined) {
		params.CONTENT_LENGTH = String(Buffer.byteLength(opts.body, "utf8"));
	}

	const wire = Buffer.concat([
		beginRequest(1, Role.RESPONDER),
		paramsRecord(1, params),
		emptyRecord(RecordType.PARAMS, 1),
		...(opts.body !== undefined ? [stdinRecord(1, opts.body)] : []),
		emptyRecord(RecordType.STDIN, 1),
	]);

	const records = await sendAndCollect(opts.port, wire);

	const stdout = Buffer.concat(
		records
			.filter((r) => r.type === RecordType.STDOUT && r.contentData.length > 0)
			.map((r) => r.contentData),
	);

	return parseCgiResponse(stdout);
}
