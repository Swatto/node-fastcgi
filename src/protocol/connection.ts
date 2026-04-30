/**
 * Per-connection state machine for FastCGI (spec sections 3, 4, 5, 6.2).
 *
 * One `FcgiConnection` instance is created per accepted TCP/Unix socket.
 * It drives the RecordParser and manages a Map of active request states.
 *
 * Concurrency policy: we advertise FCGI_MPXS_CONNS=0, so at most one active
 * request per connection at a time. A second BEGIN_REQUEST on an active
 * connection is rejected with FCGI_CANT_MPX_CONN.
 */

import type { Socket } from "node:net";
import { ProtocolError } from "../errors.js";
import {
	FCGI_KEEP_CONN,
	FCGI_MAX_CONNS,
	FCGI_MAX_REQS,
	FCGI_MPXS_CONNS,
	FCGI_NULL_REQUEST_ID,
	FCGI_VERSION_1,
	ProtocolStatus,
	RecordType,
	Role,
} from "./constants.js";
import { decodeNameValues, encodeNameValues } from "./nameValue.js";
import { encodeRecord, RecordParser } from "./record.js";

// ---------------------------------------------------------------------------
// Types exposed to the layer above
// ---------------------------------------------------------------------------

/** State for a single FastCGI request that has been accepted but not yet ended. */
export interface RequestState {
	requestId: number;
	role: number;
	keepConn: boolean;
	params: Map<string, string>;
	/**
	 * HTTP request headers pre-built from PARAMS during accumulation.
	 * HTTP_* CGI variables are translated to their header names
	 * (e.g. HTTP_X_REQUEST_ID → x-request-id) and CONTENT_TYPE /
	 * CONTENT_LENGTH are included. Avoids a second full scan of `params`
	 * inside `buildRequest`.
	 */
	httpHeaders: Headers;
	paramsComplete: boolean;
	/** Push raw STDIN bytes into the body stream. */
	pushStdin: (chunk: Buffer) => void;
	/** Signal that the STDIN stream has ended (empty STDIN record received). */
	endStdin: () => void;
	/** Abort the request (ABORT_REQUEST received or socket closed). */
	abort: (reason?: Error) => void;
	/** STDIN as a byte stream for this request. */
	readonly stdinStream: ReadableStream<Uint8Array>;
	/** Aborts when the server aborts the request or the connection drops. */
	readonly abortSignal: AbortSignal;
	/** True after END_REQUEST has been sent or the request was ended by abort. */
	ended: boolean;
	/** Accumulated raw bytes of PARAMS content (non-terminator chunks) for this request. */
	paramsBytes: number;
	/** Flush any STDIN bytes received before paramsComplete. Idempotent; no-op once flushed. */
	flushPendingStdin: () => void;
}

/** Callbacks the connection calls upward when request lifecycle events occur. */
export interface ConnectionCallbacks {
	/**
	 * Called when PARAMS is complete and the request is ready to be dispatched.
	 * The handler will start receiving STDIN chunks via `state.pushStdin`.
	 * The handler must write its response to `socket` using the provided write helpers.
	 */
	onRequest: (state: RequestState, socket: Socket) => void;

	/** Called when any non-recoverable error occurs on the connection. */
	onError?: (err: Error) => void;

	/** Forwarded to RecordParser; see RecordParserOptions.maxBufferedBytes. Default 8 MiB. */
	maxBufferedBytes?: number;

	/**
	 * Maximum total bytes accepted in a single request body (FCGI_STDIN).
	 * Requests exceeding this limit are aborted and the connection is destroyed.
	 * Default: unlimited.
	 */
	maxBodyBytes?: number;

	/** Maximum total bytes accepted across all FCGI_PARAMS records for one request. Default: 65536. */
	maxParamsBytes?: number;

	/** Maximum number of name/value pairs accepted per request. Default: 1000. */
	maxParamsCount?: number;

	/**
	 * Maximum number of requests allowed on this connection before it is closed.
	 * After the limit is reached the socket is ended following the last response.
	 * Default: unlimited.
	 */
	maxRequestsPerConnection?: number;

	/**
	 * Value advertised as FCGI_MAX_CONNS / FCGI_MAX_REQS in the GET_VALUES_RESULT
	 * reply (spec §4.1). Defaults to 1024 when unset. Should reflect the real
	 * concurrency the server is willing to accept.
	 */
	maxConcurrentConnections?: number;
}

// ---------------------------------------------------------------------------
// FcgiConnection
// ---------------------------------------------------------------------------

export class FcgiConnection {
	private readonly socket: Socket;
	private readonly callbacks: ConnectionCallbacks;
	private readonly parser: RecordParser;

	/**
	 * Active requests on this connection, keyed by requestId.
	 * With MPXS=0 there will be at most one entry.
	 */
	private readonly requests = new Map<number, RequestState>();

	/** Total requests dispatched on this connection (for optional per-connection caps). */
	private requestCount = 0;

	/** Request IDs for which END_REQUEST was already written (idempotent `sendEndRequest`). Cleared on socket close; see `handleBeginRequest`. */
	private readonly endedRequestIds = new Set<number>();

	/**
	 * Reusable 16-byte buffer for FCGI_END_REQUEST records.
	 * END_REQUEST is always exactly 16 bytes (8-byte header + 8-byte body, no padding).
	 * Only bytes 2–3 (requestId), 8–11 (appStatus), and 12 (protocolStatus) vary per call.
	 * Allocated once per connection to avoid two Buffer.allocUnsafe calls per request.
	 */
	private readonly endRequestBuf: Buffer = (() => {
		const buf = Buffer.allocUnsafe(16);
		buf[0] = FCGI_VERSION_1;
		buf[1] = RecordType.END_REQUEST;
		// bytes 2-3: requestId — written per call
		buf.writeUInt16BE(8, 4); // contentLength = 8
		buf[6] = 0; // paddingLength = 0
		buf[7] = 0; // reserved
		// bytes 8-11: appStatus — written per call
		// byte 12: protocolStatus — written per call
		buf[13] = 0;
		buf[14] = 0;
		buf[15] = 0;
		return buf;
	})();

	constructor(socket: Socket, callbacks: ConnectionCallbacks) {
		this.socket = socket;
		this.callbacks = callbacks;
		this.parser = new RecordParser(
			(record) => this.handleRecord(record),
			callbacks.maxBufferedBytes !== undefined
				? { maxBufferedBytes: callbacks.maxBufferedBytes }
				: undefined,
		);

		socket.on("data", (chunk: Buffer) => {
			try {
				this.parser.push(chunk);
			} catch (err) {
				this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
				socket.destroy();
			}
		});

		socket.on("close", () => this.handleSocketClose());
		socket.on("error", (err) => {
			this.callbacks.onError?.(err);
			// Treat socket errors like disconnect: abort in-flight work immediately.
			this.handleSocketClose();
		});
	}

	// ---------------------------------------------------------------------------
	// Record dispatch
	// ---------------------------------------------------------------------------

	private handleRecord(record: { type: number; requestId: number; contentData: Buffer }): void {
		const { type, requestId, contentData } = record;

		// Management records (requestId === 0)
		if (requestId === FCGI_NULL_REQUEST_ID) {
			this.handleManagementRecord(type, contentData);
			return;
		}

		// BEGIN_REQUEST is the only application record we accept for inactive IDs
		if (type === RecordType.BEGIN_REQUEST) {
			this.handleBeginRequest(requestId, contentData);
			return;
		}

		// Ignore records for inactive request IDs (spec sec 3.3)
		const req = this.requests.get(requestId);
		if (req === undefined) return;

		switch (type) {
			case RecordType.PARAMS:
				this.handleParams(req, contentData);
				break;
			case RecordType.STDIN:
				this.handleStdin(req, contentData);
				break;
			case RecordType.ABORT_REQUEST:
				this.handleAbortRequest(req);
				break;
			default:
				// Unknown application record type — no action required by spec
				break;
		}
	}

	// ---------------------------------------------------------------------------
	// Management records (spec sec 4)
	// ---------------------------------------------------------------------------

	private handleManagementRecord(type: number, contentData: Buffer): void {
		if (type === RecordType.GET_VALUES) {
			this.handleGetValues(contentData);
		} else {
			// Unknown management record type → reply with FCGI_UNKNOWN_TYPE (spec sec 4.2)
			const body = Buffer.alloc(8);
			body[0] = type;
			// bytes 1-7 are reserved (zeroed)
			this.socketWrite(encodeRecord(RecordType.UNKNOWN_TYPE, FCGI_NULL_REQUEST_ID, body));
		}
	}

	private handleGetValues(contentData: Buffer): void {
		// The request contains name/value pairs with empty values; we fill in ours.
		const query = decodeNameValues(contentData);
		const response = new Map<string, string>();

		const advertised = String(this.callbacks.maxConcurrentConnections ?? 1024);
		if (query.has(FCGI_MAX_CONNS)) response.set(FCGI_MAX_CONNS, advertised);
		if (query.has(FCGI_MAX_REQS)) response.set(FCGI_MAX_REQS, advertised);
		if (query.has(FCGI_MPXS_CONNS)) response.set(FCGI_MPXS_CONNS, "0");

		this.socketWrite(
			encodeRecord(RecordType.GET_VALUES_RESULT, FCGI_NULL_REQUEST_ID, encodeNameValues(response)),
		);
	}

	// ---------------------------------------------------------------------------
	// Application records (spec sec 5)
	// ---------------------------------------------------------------------------

	private handleBeginRequest(requestId: number, contentData: Buffer): void {
		this.endedRequestIds.delete(requestId);

		// Reject multiplexing (spec sec 5.5 / sec 4.1 FCGI_MPXS_CONNS=0)
		if (this.requests.size > 0) {
			// Don't close the socket — the existing active request's keepConn flag governs the connection.
			this.sendEndRequest(requestId, 0, ProtocolStatus.CANT_MPX_CONN, { skipClose: true });
			return;
		}

		if (contentData.length < 8) {
			const err = new ProtocolError(`BEGIN_REQUEST body too short: ${contentData.length} bytes`);
			this.callbacks.onError?.(err);
			this.socket.destroy();
			return;
		}

		const role = contentData.readUInt16BE(0);
		const flags = contentData[2] as number;
		const keepConn = (flags & FCGI_KEEP_CONN) !== 0;

		// Only Responder role is supported (spec sec 6.3/6.4 excluded)
		if (role !== Role.RESPONDER) {
			this.sendEndRequest(requestId, 0, ProtocolStatus.UNKNOWN_ROLE, { forceClose: true });
			return;
		}

		const maxBodyBytes = this.callbacks.maxBodyBytes;
		let bodyBytes = 0;
		/** Non-null only while PARAMS is incomplete; buffered STDIN until the PARAMS terminator. */
		let pendingStdin: Buffer[] | null = [];
		let stdinEndedEarly = false;

		// Build the STDIN ReadableStream plumbing
		let stdinController!: ReadableStreamDefaultController<Uint8Array>;
		const stdinAbort = new AbortController();
		const socket = this.socket;

		const pushStdinPayload = (chunk: Buffer) => {
			try {
				stdinController.enqueue(chunk);
				if ((stdinController.desiredSize ?? 1) <= 0) {
					socket.pause();
				}
			} catch {
				// Controller already closed/errored — ignore
			}
		};

		// Backpressure: pause the socket when the stream's internal queue is full;
		// `pull` resumes when the consumer reads.
		const stdinStream = new ReadableStream<Uint8Array>({
			start(ctrl) {
				stdinController = ctrl;
			},
			pull() {
				socket.resume();
			},
			cancel() {
				stdinAbort.abort(new Error("STDIN stream cancelled"));
			},
		});

		let state!: RequestState;
		state = {
			requestId,
			role,
			keepConn,
			params: new Map(),
			httpHeaders: new Headers(),
			paramsComplete: false,
			stdinStream,
			abortSignal: stdinAbort.signal,
			ended: false,
			paramsBytes: 0,
			flushPendingStdin: () => {
				if (pendingStdin === null) return;
				const queued = pendingStdin;
				pendingStdin = null;
				for (const chunk of queued) {
					pushStdinPayload(chunk);
				}
				if (stdinEndedEarly) {
					try {
						stdinController.close();
					} catch {
						// Already closed
					}
				}
			},
			pushStdin: (chunk) => {
				if (maxBodyBytes !== undefined) {
					bodyBytes += chunk.length;
					if (bodyBytes > maxBodyBytes) {
						const err = new ProtocolError(
							`Request body exceeds maxBodyBytes (limit: ${maxBodyBytes} bytes)`,
						);
						this.callbacks.onError?.(err);
						state.abort(err);
						this.socket.destroy();
						return;
					}
				}
				if (!state.paramsComplete) {
					// PARAMS terminator hasn't arrived yet — buffer so we don't pause the socket
					// waiting for a reader that hasn't been dispatched.
					(pendingStdin as Buffer[]).push(chunk);
					return;
				}
				pushStdinPayload(chunk);
			},
			endStdin: () => {
				if (!state.paramsComplete) {
					stdinEndedEarly = true;
					return;
				}
				try {
					stdinController.close();
				} catch {
					// Already closed
				}
			},
			abort: (reason) => {
				pendingStdin = null;
				stdinAbort.abort(reason);
				try {
					stdinController.error(reason ?? new Error("Request aborted"));
				} catch {
					// Already closed/errored
				}
			},
		};

		this.requestCount++;
		this.requests.set(requestId, state);
	}

	private handleParams(req: RequestState, contentData: Buffer): void {
		if (req.paramsComplete) {
			return;
		}

		const maxParamsBytes = this.callbacks.maxParamsBytes ?? 65536;
		const maxParamsCount = this.callbacks.maxParamsCount ?? 1000;

		if (contentData.length === 0) {
			req.paramsComplete = true;
			this.callbacks.onRequest(req, this.socket);
			req.flushPendingStdin();
			return;
		}

		if (req.paramsBytes + contentData.length > maxParamsBytes) {
			const err = new ProtocolError(
				`PARAMS size limit exceeded for request ${req.requestId} ` +
					`(limit: ${maxParamsBytes} bytes)`,
			);
			this.callbacks.onError?.(err);
			this.socket.destroy();
			return;
		}

		try {
			decodeNameValues(contentData, req.params, (name, value) => {
				if (name.startsWith("HTTP_")) {
					// HTTP_X_FORWARDED_FOR → x-forwarded-for
					req.httpHeaders.append(
						name.slice(5).toLowerCase().replaceAll("_", "-"),
						value,
					);
				} else if (name === "CONTENT_TYPE") {
					req.httpHeaders.set("content-type", value);
				} else if (name === "CONTENT_LENGTH" && /^\d+$/.test(value)) {
					req.httpHeaders.set("content-length", value);
				}
			});
		} catch (e) {
			const err =
				e instanceof ProtocolError
					? e
					: new ProtocolError(e instanceof Error ? e.message : String(e));
			this.callbacks.onError?.(err);
			this.socket.destroy();
			return;
		}

		if (req.params.size > maxParamsCount) {
			const err = new ProtocolError(
				`PARAMS pair count limit exceeded for request ${req.requestId} ` +
					`(limit: ${maxParamsCount})`,
			);
			this.callbacks.onError?.(err);
			this.socket.destroy();
			return;
		}

		req.paramsBytes += contentData.length;
	}

	private handleStdin(req: RequestState, contentData: Buffer): void {
		if (contentData.length === 0) {
			req.endStdin();
		} else {
			req.pushStdin(contentData);
		}
	}

	private handleAbortRequest(req: RequestState): void {
		// Send END_REQUEST eagerly so the request slot doesn't leak if the handler hangs;
		// the dispatcher skips further response work when `state.ended` is set.
		req.ended = true;
		req.abort(new Error(`Request ${req.requestId} aborted by web server`));
		this.sendEndRequest(req.requestId, 0, ProtocolStatus.REQUEST_COMPLETE, { skipClose: true });
	}

	// ---------------------------------------------------------------------------
	// Socket close handling
	// ---------------------------------------------------------------------------

	private handleSocketClose(): void {
		for (const req of this.requests.values()) {
			req.abort(new Error("Connection closed"));
		}
		this.requests.clear();
		this.endedRequestIds.clear();
	}

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	sendEndRequest(
		requestId: number,
		appStatus: number,
		protocolStatus: ProtocolStatus,
		opts: { forceClose?: boolean; skipClose?: boolean } = {},
	): void {
		if (this.endedRequestIds.has(requestId)) return;
		this.endedRequestIds.add(requestId);

		// Fill the reusable template in-place: only the three varying fields change.
		this.endRequestBuf.writeUInt16BE(requestId, 2);
		this.endRequestBuf.writeUInt32BE(appStatus, 8);
		this.endRequestBuf[12] = protocolStatus;
		this.socketWrite(this.endRequestBuf);

		const req = this.requests.get(requestId);
		this.requests.delete(requestId);
		if (req !== undefined) {
			req.ended = true;
		}

		if (!opts.skipClose) {
			const limitReached =
				this.callbacks.maxRequestsPerConnection !== undefined &&
				this.requestCount >= this.callbacks.maxRequestsPerConnection;
			const shouldClose =
				opts.forceClose ||
				limitReached ||
				(req !== undefined && !req.keepConn) ||
				req === undefined;
			if (shouldClose) {
				this.socket.end();
			}
		}
	}

	private socketWrite(buf: Buffer): void {
		if (!this.socket.destroyed) {
			this.socket.write(buf);
		}
	}
}
