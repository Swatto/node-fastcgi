import { describe, expect, it } from "vitest";
import type { RequestState } from "../../src/protocol/connection.js";
import { buildRequest } from "../../src/request.js";

function buildHttpHeaders(params: Record<string, string>): Headers {
	const headers = new Headers();
	for (const [key, value] of Object.entries(params)) {
		if (key.startsWith("HTTP_")) {
			headers.append(key.slice(5).toLowerCase().replaceAll("_", "-"), value);
		} else if (key === "CONTENT_TYPE") {
			headers.set("content-type", value);
		} else if (key === "CONTENT_LENGTH" && /^\d+$/.test(value)) {
			headers.set("content-length", value);
		}
	}
	return headers;
}

function makeState(params: Record<string, string>): RequestState {
	return {
		requestId: 1,
		role: 1,
		keepConn: false,
		params: new Map(Object.entries(params)),
		httpHeaders: buildHttpHeaders(params),
		paramsComplete: true,
		paramsBytes: 0,
		ended: false,
		stdinStream: new ReadableStream<Uint8Array>(),
		abortSignal: new AbortController().signal,
		pushStdin: () => {},
		endStdin: () => {},
		flushPendingStdin: () => {},
		abort: () => {},
	};
}

describe("buildRequest", () => {
	describe("Content-Length (CONTENT_LENGTH)", () => {
		it("preserves Content-Length: 0 on POST", () => {
			const req = buildRequest(
				makeState({
					REQUEST_METHOD: "POST",
					REQUEST_URI: "/",
					HTTP_HOST: "x:1",
					CONTENT_LENGTH: "0",
				}),
			);
			expect(req.headers.get("content-length")).toBe("0");
		});

		it("preserves numeric Content-Length", () => {
			const req = buildRequest(
				makeState({
					REQUEST_METHOD: "POST",
					REQUEST_URI: "/",
					HTTP_HOST: "x:1",
					CONTENT_LENGTH: "42",
				}),
			);
			expect(req.headers.get("content-length")).toBe("42");
		});

		it("drops garbage Content-Length", () => {
			const req = buildRequest(
				makeState({
					REQUEST_METHOD: "POST",
					REQUEST_URI: "/",
					HTTP_HOST: "x:1",
					CONTENT_LENGTH: "not-a-number",
				}),
			);
			expect(req.headers.get("content-length")).toBeNull();
		});

		it("leaves Content-Length unset when missing", () => {
			const req = buildRequest(
				makeState({
					REQUEST_METHOD: "POST",
					REQUEST_URI: "/",
					HTTP_HOST: "x:1",
				}),
			);
			expect(req.headers.get("content-length")).toBeNull();
		});
	});

	describe("HTTPS → URL scheme", () => {
		it("uses https when HTTPS=on", () => {
			const req = buildRequest(
				makeState({
					REQUEST_METHOD: "GET",
					REQUEST_URI: "/",
					HTTP_HOST: "x:1",
					HTTPS: "on",
				}),
			);
			expect(new URL(req.url).protocol).toBe("https:");
		});

		it("uses https when HTTPS=1", () => {
			const req = buildRequest(
				makeState({
					REQUEST_METHOD: "GET",
					REQUEST_URI: "/",
					HTTP_HOST: "x:1",
					HTTPS: "1",
				}),
			);
			expect(new URL(req.url).protocol).toBe("https:");
		});

		it("uses http when HTTPS=off", () => {
			const req = buildRequest(
				makeState({
					REQUEST_METHOD: "GET",
					REQUEST_URI: "/",
					HTTP_HOST: "x:1",
					HTTPS: "off",
				}),
			);
			expect(new URL(req.url).protocol).toBe("http:");
		});

		it("uses http when HTTPS=0", () => {
			const req = buildRequest(
				makeState({
					REQUEST_METHOD: "GET",
					REQUEST_URI: "/",
					HTTP_HOST: "x:1",
					HTTPS: "0",
				}),
			);
			expect(new URL(req.url).protocol).toBe("http:");
		});

		it("uses http when HTTPS is missing", () => {
			const req = buildRequest(
				makeState({
					REQUEST_METHOD: "GET",
					REQUEST_URI: "/",
					HTTP_HOST: "x:1",
				}),
			);
			expect(new URL(req.url).protocol).toBe("http:");
		});

		it("treats uppercase ON as https", () => {
			const req = buildRequest(
				makeState({
					REQUEST_METHOD: "GET",
					REQUEST_URI: "/",
					HTTP_HOST: "x:1",
					HTTPS: "ON",
				}),
			);
			expect(new URL(req.url).protocol).toBe("https:");
		});
	});
});
