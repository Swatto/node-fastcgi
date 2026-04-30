/**
 * `serve(handler, options)` — the single public entrypoint.
 *
 * Binds a listening socket, accepts connections, and dispatches each
 * FastCGI request to `handler: (req: Request) => Response | Promise<Response>`.
 *
 * Transport resolution order (spec sec 2.2, 3.2):
 *   1. `options.server`      — caller-supplied net.Server (already listening or will be)
 *   2. `options.inheritedFd` — fd inherited from web server (FCGI_LISTENSOCK_FILENO = 0)
 *   3. `options.socketPath`  — Unix domain socket path
 *   4. `options.port`        — TCP port (default host: "127.0.0.1")
 */

import { chmodSync, fstatSync } from "node:fs";
import type { AddressInfo, Server, Socket } from "node:net";
import { createServer, isIPv4, isIPv6 } from "node:net";
import { ConnectionDeniedError, HandlerError } from "./errors.js";
import type { RequestState } from "./protocol/connection.js";
import { FcgiConnection } from "./protocol/connection.js";
import { buildRequest } from "./request.js";
import { writeResponse, writeStderr } from "./response.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A handler function compatible with the Fetch API's Request/Response contract. */
export type Handler = (request: Request) => Response | Promise<Response>;

export interface ServeOptions {
	/** TCP port number to listen on. */
	port?: number;
	/** TCP host/IP to bind to (default: "127.0.0.1"). */
	host?: string;
	/** Unix domain socket path to listen on. */
	socketPath?: string;
	/**
	 * File-mode permissions applied to the Unix domain socket after binding
	 * (e.g. `0o660` to restrict access to the owner and group).
	 * Only meaningful when `socketPath` is set.
	 */
	socketMode?: number;
	/** Use a pre-created `net.Server` instance (caller manages lifecycle). */
	server?: Server;
	/**
	 * File descriptor of a listening socket inherited from the web server
	 * (spec sec 2.2: FCGI_LISTENSOCK_FILENO = 0).
	 */
	inheritedFd?: number;
	/**
	 * Allowed peer IP addresses (spec sec 3.2: FCGI_WEB_SERVER_ADDRS).
	 * TCP connections from unlisted IPs are immediately closed.
	 * Note: this option is TCP-only; Unix-socket connections are always allowed.
	 */
	allowedAddresses?: string[];
	/**
	 * AbortSignal that, when aborted, triggers a graceful shutdown of the server.
	 */
	signal?: AbortSignal;
	/**
	 * Milliseconds of inactivity after which an idle connection is closed.
	 * Default: no timeout. Recommended: 60_000 (60 s).
	 */
	idleTimeout?: number;
	/**
	 * After `idleTimeout` triggers `socket.end()`, milliseconds to wait before
	 * forcing `socket.destroy()` if the peer keeps the FD open. Default: 5000.
	 */
	idleGraceMs?: number;
	/**
	 * Maximum number of concurrent TCP connections the server will accept.
	 * Connections beyond this limit are dropped by the OS backlog.
	 * Default: unlimited.
	 */
	maxConnections?: number;
	/**
	 * Maximum number of FastCGI requests handled on a single keep-alive connection
	 * before the connection is closed. Helps prevent resource exhaustion from a
	 * single connection sending unlimited back-to-back requests.
	 * Default: unlimited.
	 */
	maxRequestsPerConnection?: number;
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
	 * Maximum milliseconds to wait for active connections to drain after `close()`.
	 * After the timeout, remaining sockets are force-destroyed. Default: 5000 (5 s).
	 */
	closeTimeout?: number;
	/**
	 * Maximum milliseconds a handler may run for a single request before it is
	 * aborted via the request's AbortSignal. After abort, an Internal Server Error
	 * response is sent and `onError` is called with a TimeoutError-named Error.
	 * Default: no timeout.
	 */
	handlerTimeout?: number;
	/**
	 * When `true`, the full `Error.name: Error.message` string is forwarded to
	 * FastCGI STDERR after handler failure. When `false` (default), STDERR carries
	 * no diagnostics for thrown handlers (noise-free); still use `onError` for
	 * structured server-side logging.
	 */
	verboseErrors?: boolean;
	/**
	 * Called when a handler throws or the connection encounters a protocol error.
	 * Return a `Response` (or `{ response?, appStatus? }`) to customise the error
	 * reply; return `void`/`undefined` to send a generic 500.
	 *
	 * `appStatus` in the returned object overrides the default `1` used for handler
	 * errors. `req` is `undefined` for connection-level errors where no response
	 * can be sent (the return value is ignored in that case).
	 */
	onError?: (
		err: unknown,
		req?: Request,
	) => Response | { response?: Response; appStatus?: number } | undefined;
}

export interface ServeResult {
	/** Gracefully close the server (stops accepting new connections). */
	close(): Promise<void>;
	/** The bound address: an AddressInfo for TCP, a string path for Unix sockets. */
	address: AddressInfo | string | null;
}

// ---------------------------------------------------------------------------
// serve()
// ---------------------------------------------------------------------------

export function serve(handler: Handler, options: ServeOptions = {}): Promise<ServeResult> {
	const transportCount = [
		options.server,
		options.inheritedFd,
		options.socketPath,
		options.port,
	].filter((v) => v !== undefined).length;
	if (transportCount > 1) {
		return Promise.reject(
			new TypeError(
				"serve(): only one transport option may be specified at a time " +
					"(server, inheritedFd, socketPath, or port)",
			),
		);
	}

	return new Promise<ServeResult>((resolve, reject) => {
		const server = options.server ?? createServer();

		let prevUmask: number | undefined;

		if (options.maxConnections !== undefined) {
			server.maxConnections = options.maxConnections;
		}

		const activeSockets = new Set<Socket>();

		server.on("connection", (socket: Socket) => {
			activeSockets.add(socket);
			socket.once("close", () => activeSockets.delete(socket));
			handleConnection(socket, handler, options);
		});

		server.on("error", reject);

		const onListening = () => {
			server.off("error", reject);

			// After listen, avoid default EventEmitter "error" throws; surface via onError instead.
			server.on("error", (err) => options.onError?.(err));

			if (prevUmask !== undefined) {
				process.umask(prevUmask);
			}

			if (options.socketPath && options.socketMode !== undefined) {
				try {
					chmodSync(options.socketPath, options.socketMode);
				} catch (err) {
					// Non-fatal: log via onError and continue
					options.onError?.(err);
				}
			}

			// Wire AbortSignal → graceful shutdown
			const closeDrainMs = options.closeTimeout ?? 5000;
			if (options.signal) {
				const shutdown = () => closeServer(server, activeSockets, closeDrainMs);
				if (options.signal.aborted) {
					shutdown();
				} else {
					options.signal.addEventListener("abort", shutdown, { once: true });
				}
			}

			resolve({
				close: () => closeServer(server, activeSockets, closeDrainMs),
				address: server.address(),
			});
		};

		if (options.server) {
			// Caller-supplied server: may already be listening
			if (options.server.listening) {
				onListening();
			} else {
				server.once("listening", onListening);
				server.listen();
			}
		} else if (options.inheritedFd !== undefined) {
			try {
				const stat = fstatSync(options.inheritedFd);
				if (!stat.isSocket()) {
					reject(
						new Error(
							`inheritedFd ${options.inheritedFd} is not a socket ` +
								`(got file type ${stat.mode & 0o170000})`,
						),
					);
					return;
				}
			} catch (err) {
				reject(err);
				return;
			}
			server.once("listening", onListening);
			server.listen({ fd: options.inheritedFd });
		} else if (options.socketPath !== undefined) {
			if (options.socketMode !== undefined) {
				prevUmask = process.umask(0o777 ^ options.socketMode);
			}
			server.once("listening", onListening);
			server.listen(options.socketPath);
		} else {
			server.once("listening", onListening);
			server.listen(options.port ?? 0, options.host ?? "127.0.0.1");
		}
	});
}

// ---------------------------------------------------------------------------
// Per-connection handler
// ---------------------------------------------------------------------------

function handleConnection(socket: Socket, handler: Handler, options: ServeOptions): void {
	if (options.idleTimeout) {
		socket.setTimeout(options.idleTimeout);
		socket.on("timeout", () => {
			socket.end();
			const idleGraceMs = options.idleGraceMs ?? 5000;
			const grace = setTimeout(() => {
				if (!socket.destroyed) socket.destroy();
			}, idleGraceMs);
			grace.unref();
			socket.once("close", () => clearTimeout(grace));
		});
	}

	// Spec sec 3.2: FCGI_WEB_SERVER_ADDRS — TCP peer check (`remoteAddress` is unset on Unix sockets).
	if (options.allowedAddresses && options.allowedAddresses.length > 0) {
		const peerAddress = socket.remoteAddress;
		if (peerAddress !== undefined) {
			if (!matchAllowedAddress(peerAddress, options.allowedAddresses)) {
				const normalized = peerAddress.replace(/^::ffff:/i, "");
				options.onError?.(new ConnectionDeniedError(normalized));
				socket.destroy();
				return;
			}
		}
	}

	// Declare before assignment so the onRequest closure can capture the typed variable.
	let conn: FcgiConnection;
	conn = new FcgiConnection(socket, {
		onRequest: (state, sock) => dispatchRequest(state, sock, conn, handler, options),
		// Connection-level errors have no Fetch request; a returned Response cannot be sent.
		onError: (err) => {
			options.onError?.(err, undefined);
		},
		// exactOptionalPropertyTypes: only include each limit field when defined.
		...(options.maxRequestsPerConnection !== undefined
			? { maxRequestsPerConnection: options.maxRequestsPerConnection }
			: {}),
		...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
		...(options.maxParamsBytes !== undefined ? { maxParamsBytes: options.maxParamsBytes } : {}),
		...(options.maxParamsCount !== undefined ? { maxParamsCount: options.maxParamsCount } : {}),
		...(options.maxConnections !== undefined
			? { maxConcurrentConnections: options.maxConnections }
			: {}),
	});
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

async function dispatchRequest(
	state: RequestState,
	socket: Socket,
	conn: FcgiConnection,
	handler: Handler,
	options: ServeOptions,
): Promise<void> {
	const requestId = state.requestId;
	let req: Request | undefined;

	try {
		req = buildRequest(state);
	} catch (err) {
		options.onError?.(err);
		const response = new Response("Bad Request", { status: 400 });
		await writeResponse(response, requestId, 1, socket, conn);
		return;
	}

	let response!: Response;
	let appStatus = 0;
	let handlerThrew = false;
	let stderrMessage = "";
	let timer: NodeJS.Timeout | undefined;
	const timeoutMs = options.handlerTimeout;
	const useTimeout = timeoutMs !== undefined && timeoutMs > 0 && Number.isFinite(timeoutMs);

	const handlerPromiseOrRace = (): Promise<Response> => {
		const hp = Promise.resolve(handler(req));
		if (useTimeout) {
			hp.catch(() => {});
		}
		if (!useTimeout) return hp;
		return Promise.race([
			hp,
			new Promise<Response>((_, rej) => {
				timer = setTimeout(() => {
					const timeoutErr = Object.assign(new Error(`Handler timed out after ${timeoutMs} ms`), {
						name: "TimeoutError",
					});
					state.abort(timeoutErr);
					rej(timeoutErr);
				}, timeoutMs);
				timer.unref();
			}),
		]);
	};

	try {
		response = await handlerPromiseOrRace();
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	} catch (err) {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		handlerThrew = true;
		appStatus = 1;

		const isTimeout = err instanceof Error && err.name === "TimeoutError";
		if (isTimeout) {
			options.onError?.(err, req);
			response = new Response("Internal Server Error", { status: 500 });
			stderrMessage = options.verboseErrors
				? err instanceof Error
					? `${err.name}: ${err.message}`
					: String(err)
				: "";
		} else {
			const handlerErr = new HandlerError("Handler threw an error", err);

			const errorResult = options.onError?.(handlerErr, req);
			if (errorResult instanceof Response) {
				response = errorResult;
			} else if (errorResult !== undefined && errorResult !== null) {
				response = errorResult.response ?? new Response("Internal Server Error", { status: 500 });
				appStatus = errorResult.appStatus ?? 1;
			} else {
				response = new Response("Internal Server Error", { status: 500 });
			}

			stderrMessage = options.verboseErrors
				? err instanceof Error
					? `${err.name}: ${err.message}`
					: String(err)
				: "";
		}
	}

	if (state.ended) {
		return;
	}

	if (handlerThrew && options.verboseErrors && stderrMessage.length > 0) {
		try {
			await writeStderr(socket, requestId, stderrMessage);
		} catch (writeErr) {
			options.onError?.(writeErr, req);
		}
	}

	try {
		await writeResponse(response, requestId, appStatus, socket, conn);
	} catch (err) {
		options.onError?.(err, req);
	}
}

function ipv4EmbeddedPeerString(peerRaw: string): string | null {
	const t = peerRaw.trim();
	const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(t);
	if (m?.[1]) return m[1];
	if (isIPv4(t)) return t;
	return null;
}

function parseIPv4String(s: string): number | null {
	const t = s.trim();
	if (!isIPv4(t)) return null;
	const parts = t.split(".");
	if (parts.length !== 4) return null;
	let acc = 0;
	for (let i = 0; i < 4; i++) {
		const v = Number(parts[i]);
		if (!Number.isInteger(v) || v < 0 || v > 255) return null;
		acc = (((acc << 8) >>> 0) + v) >>> 0;
	}
	return acc >>> 0;
}

function ipv4PrefixBitsMatch(ip: number, network: number, prefixBits: number): boolean {
	if (prefixBits < 0 || prefixBits > 32) return false;
	if (prefixBits === 0) return true;
	if (prefixBits === 32) return ip === network;
	const mask = (0xffffffff << (32 - prefixBits)) >>> 0;
	return (ip & mask) >>> 0 === (network & mask) >>> 0;
}

function ipv6BufferEquals(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== 16 || b.length !== 16) return false;
	for (let i = 0; i < 16; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function ipv6PrefixBitsMatch(peer: Uint8Array, network: Uint8Array, prefixLen: number): boolean {
	if (prefixLen < 0 || prefixLen > 128) return false;
	const fullBytes = prefixLen >>> 3;
	for (let i = 0; i < fullBytes; i++) {
		if (peer[i] !== network[i]) return false;
	}
	const rem = prefixLen & 7;
	if (rem === 0) return true;
	const mask = (0xff << (8 - rem)) & 0xff;
	return ((peer[fullBytes] ?? 0) & mask) === ((network[fullBytes] ?? 0) & mask);
}

function parseIPv6String(addr: string): Uint8Array | null {
	let s = addr.trim().toLowerCase();
	const zi = s.indexOf("%");
	if (zi !== -1) s = s.slice(0, zi);

	const mf = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
	if (mf?.[1]) {
		const v4 = parseIPv4String(mf[1]);
		if (v4 === null) return null;
		const out = new Uint8Array(16);
		out[10] = 0xff;
		out[11] = 0xff;
		out[12] = (v4 >>> 24) & 0xff;
		out[13] = (v4 >>> 16) & 0xff;
		out[14] = (v4 >>> 8) & 0xff;
		out[15] = v4 & 0xff;
		return out;
	}

	if (isIPv4(s)) return null;

	if (!isIPv6(s)) return null;

	const double = s.split("::");
	if (double.length > 2) return null;

	const left =
		double[0] !== undefined && double[0].length > 0 ? double[0].split(":").filter(Boolean) : [];
	const right =
		double[1] !== undefined && double[1].length > 0 ? double[1].split(":").filter(Boolean) : [];

	if (double.length === 2 && right.length === 1 && right[0]?.includes(".")) {
		const v4str = right[0] ?? "";
		const v4 = parseIPv4String(v4str);
		if (v4 === null) return null;
		let bi = 0;
		const out = new Uint8Array(16);
		for (const g of left) {
			if (g.includes(".")) return null;
			const n = parseInt(g, 16);
			if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
			out[bi++] = (n >>> 8) & 0xff;
			out[bi++] = n & 0xff;
		}
		if (bi >= 12) return null;
		while (bi < 12) out[bi++] = 0;
		out[12] = (v4 >>> 24) & 0xff;
		out[13] = (v4 >>> 16) & 0xff;
		out[14] = (v4 >>> 8) & 0xff;
		out[15] = v4 & 0xff;
		return out;
	}

	if (left.some((g) => g.includes(".")) || right.some((g) => g.includes("."))) return null;

	const miss = 8 - left.length - right.length;
	if (miss < 0) return null;

	const groups = [...left, ...Array<string>(miss).fill("0"), ...right];

	if (groups.length !== 8) return null;

	const out = new Uint8Array(16);
	let bi = 0;
	for (const g of groups) {
		const n = parseInt(g, 16);
		if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
		out[bi++] = (n >>> 8) & 0xff;
		out[bi++] = n & 0xff;
	}
	return out;
}

function matchAllowedEntry(peerRaw: string, entry: string): boolean {
	const e = entry.trim();
	const slashIdx = e.indexOf("/");

	if (slashIdx === -1) {
		if (isIPv4(e)) return ipv4EmbeddedPeerString(peerRaw) === e;
		if (isIPv6(e)) {
			const a = parseIPv6String(peerRaw);
			const b = parseIPv6String(e);
			if (!a || !b) return false;
			return ipv6BufferEquals(a, b);
		}
		return false;
	}

	const prefStr = e.slice(0, slashIdx).trim();
	const prefixBitsRaw = Number(e.slice(slashIdx + 1).trim());
	if (!Number.isFinite(prefixBitsRaw) || !Number.isInteger(prefixBitsRaw)) return false;

	if (isIPv4(prefStr)) {
		const ppeer = ipv4EmbeddedPeerString(peerRaw);
		if (!ppeer) return false;
		const ip = parseIPv4String(ppeer);
		const nw = parseIPv4String(prefStr);
		if (ip === null || nw === null) return false;
		return ipv4PrefixBitsMatch(ip, nw, prefixBitsRaw);
	}

	if (isIPv6(prefStr)) {
		const pb = parseIPv6String(peerRaw);
		const nb = parseIPv6String(prefStr);
		if (!pb || !nb) return false;
		return ipv6PrefixBitsMatch(pb, nb, prefixBitsRaw);
	}

	return false;
}

function matchAllowedAddress(peerRaw: string, allowed: readonly string[]): boolean {
	for (const x of allowed) {
		if (matchAllowedEntry(peerRaw, x)) return true;
	}
	return false;
}

/**
 * Close `server` gracefully: stop accepting new connections, then end all
 * tracked client sockets so `net.Server.close` can finish (otherwise open
 * peers would keep the server from closing).
 */
function closeServer(
	server: Server,
	activeSockets?: Set<Socket>,
	closeDrainMs = 5000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!server.listening) {
			resolve();
			return;
		}
		let forceTimer: NodeJS.Timeout | undefined;
		if (activeSockets && activeSockets.size > 0 && closeDrainMs > 0) {
			forceTimer = setTimeout(() => {
				for (const s of activeSockets) {
					if (!s.destroyed) s.destroy();
				}
			}, closeDrainMs);
		}
		server.close((err) => {
			if (forceTimer !== undefined) clearTimeout(forceTimer);
			if (err) reject(err);
			else resolve();
		});
		if (activeSockets) {
			for (const socket of activeSockets) {
				socket.end();
			}
		}
	});
}
