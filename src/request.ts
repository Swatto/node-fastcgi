/**
 * Builds a Web-standard `Request` from a FastCGI RequestState.
 *
 * CGI environment variable mapping (spec sec 6.2 + RFC 3875):
 *   - REQUEST_METHOD → method
 *   - HTTPS, HTTP_HOST, SERVER_NAME, SERVER_PORT, REQUEST_URI,
 *     SCRIPT_NAME, QUERY_STRING → URL
 *   - HTTP_* → request headers (underscores → hyphens, lowercased)
 *   - CONTENT_TYPE, CONTENT_LENGTH → Content-Type / Content-Length headers
 *   - Body: null for GET/HEAD; otherwise a ReadableStream fed by STDIN chunks
 *   - signal: per-request AbortSignal (aborted on ABORT_REQUEST or socket close)
 */

import type { RequestState } from "./protocol/connection.js";

/**
 * Methods that never carry a body per RFC 9110 (§9.3.1 and §9.3.2).
 * DELETE and OPTIONS are intentionally excluded: both may legally carry a body.
 */
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

/**
 * Convert a FastCGI RequestState (with completed PARAMS) into a Web `Request`.
 *
 * The returned `Request` will have:
 *  - A URL reconstructed from CGI variables
 *  - Headers built from HTTP_* and CONTENT_* CGI variables
 *  - A streaming body fed by incoming STDIN records (or null for bodyless methods)
 *  - An AbortSignal that fires if the web server aborts the request
 */
export function buildRequest(state: RequestState): Request {
	const params = state.params;

	// ------------------------------------------------------------------
	// Method
	// ------------------------------------------------------------------
	const method = params.get("REQUEST_METHOD") ?? "GET";

	// ------------------------------------------------------------------
	// URL
	// ------------------------------------------------------------------
	// Apache mod_fastcgi and some nginx configs set HTTPS=off for plain HTTP.
	const httpsValue = params.get("HTTPS")?.toLowerCase();
	const scheme = httpsValue === "on" || httpsValue === "1" ? "https" : "http";

	let authority = params.get("HTTP_HOST");
	if (!authority) {
		const serverName = params.get("SERVER_NAME") ?? "localhost";
		const serverPort = params.get("SERVER_PORT") ?? "80";
		authority =
			serverPort === "80" || serverPort === "443" ? serverName : `${serverName}:${serverPort}`;
	}

	const requestUri =
		params.get("REQUEST_URI") ??
		buildRequestUri(
			params.get("SCRIPT_NAME") ?? "/",
			params.get("PATH_INFO"),
			params.get("QUERY_STRING"),
		);

	const url = `${scheme}://${authority}${requestUri}`;

	// ------------------------------------------------------------------
	// Headers
	// ------------------------------------------------------------------
	const headers = new Headers();

	for (const [key, value] of params) {
		if (key.startsWith("HTTP_")) {
			// HTTP_X_FORWARDED_FOR → x-forwarded-for
			const headerName = key.slice(5).toLowerCase().replaceAll("_", "-");
			headers.append(headerName, value);
		}
	}

	const contentType = params.get("CONTENT_TYPE");
	if (contentType) headers.set("content-type", contentType);

	const contentLength = params.get("CONTENT_LENGTH");
	if (contentLength !== undefined && /^\d+$/.test(contentLength)) {
		headers.set("content-length", contentLength);
	}

	// ------------------------------------------------------------------
	// Body
	// ------------------------------------------------------------------
	const body = BODYLESS_METHODS.has(method.toUpperCase()) ? null : state.stdinStream;

	// ------------------------------------------------------------------
	// Signal
	// ------------------------------------------------------------------
	const signal = state.abortSignal;

	const init: RequestInit =
		body !== null
			? ({ method, headers, signal, body, duplex: "half" } as RequestInit)
			: { method, headers, signal };
	return new Request(url, init);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequestUri(
	scriptName: string,
	pathInfo: string | undefined,
	queryString: string | undefined,
): string {
	let uri = scriptName;
	if (pathInfo) uri += pathInfo;
	if (queryString) uri += `?${queryString}`;
	return uri;
}
