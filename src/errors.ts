/** Error thrown when the FastCGI protocol is violated. */
export class ProtocolError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ProtocolError";
	}
}

/** Error thrown when a connection is denied (e.g., FCGI_WEB_SERVER_ADDRS allowlist mismatch). */
export class ConnectionDeniedError extends Error {
	readonly remoteAddress: string;
	constructor(remoteAddress: string) {
		super(`Connection denied from ${remoteAddress}`);
		this.name = "ConnectionDeniedError";
		this.remoteAddress = remoteAddress;
	}
}

/** Error thrown when a user handler throws or rejects. */
export class HandlerError extends Error {
	override readonly cause: unknown;
	constructor(message: string, cause: unknown) {
		super(message, { cause });
		this.name = "HandlerError";
		this.cause = cause;
	}
}
