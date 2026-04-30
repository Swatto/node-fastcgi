/**
 * E2E test suite for node-fastcgi.
 *
 * Every test makes a real HTTP request to a reverse proxy, which forwards it
 * over the FastCGI protocol to a Node.js app built with this library.  Nothing
 * in these tests touches internal APIs — the observable surface is pure HTTP.
 *
 * The same test cases run against every proxy listed in PROXIES, so a single
 * failure is pinned to a specific proxy rather than lost in the noise.
 *
 * Stack (all containers, fully portable):
 *   fetch → <proxy>:80 → FastCGI → app:9000 (node-fastcgi) → response
 *
 * *_URL vars are injected by docker-compose.yml.
 * The fallback ports (8080/8081/8082) can be mapped when running outside
 * Docker for local debugging.
 */

import { describe, expect, it } from "vitest";

const PROXIES = [
	{ name: "nginx", base: (process.env.NGINX_URL ?? "http://localhost:8080").replace(/\/$/, "") },
	{ name: "caddy", base: (process.env.CADDY_URL ?? "http://localhost:8081").replace(/\/$/, "") },
	{ name: "apache", base: (process.env.APACHE_URL ?? "http://localhost:8082").replace(/\/$/, "") },
];

describe.each(PROXIES)("E2E — node-fastcgi behind $name", ({ base }) => {
	const get = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);
	const post = (path: string, body: string, contentType: string) =>
		fetch(`${base}${path}`, {
			method: "POST",
			body,
			headers: { "content-type": contentType },
		});

	// -------------------------------------------------------------------------
	// Basic response
	// -------------------------------------------------------------------------

	it("GET /hello → 200 with default greeting", async () => {
		const res = await get("/hello");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("Hello, World!");
	});

	it("GET /hello?name=Alice → greeting uses query param", async () => {
		const res = await get("/hello?name=Alice");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("Hello, Alice!");
	});

	// -------------------------------------------------------------------------
	// Request body (POST)
	// -------------------------------------------------------------------------

	it("POST /echo → body is reflected verbatim", async () => {
		const payload = "hello from the other side";
		const res = await post("/echo", payload, "text/plain");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(payload);
	});

	it("POST /echo → Content-Type is preserved in the response", async () => {
		const res = await post("/echo", JSON.stringify({ ping: 1 }), "application/json");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
	});

	it("POST /echo → binary-safe: multi-line body survives the round-trip", async () => {
		const payload = "line1\r\nline2\r\nline3";
		const res = await post("/echo", payload, "text/plain");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(payload);
	});

	// -------------------------------------------------------------------------
	// Request headers
	// -------------------------------------------------------------------------

	it("GET /headers → custom request header forwarded via HTTP_* CGI param", async () => {
		const res = await get("/headers", { headers: { "x-custom": "my-value" } });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("my-value");
	});

	it("GET /headers → missing custom header yields (none)", async () => {
		const res = await get("/headers");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("(none)");
	});

	// -------------------------------------------------------------------------
	// Response types
	// -------------------------------------------------------------------------

	it("GET /json → JSON body and Content-Type", async () => {
		const res = await get("/json");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const data = await res.json();
		expect(data).toMatchObject({ path: "/json", method: "GET" });
	});

	// -------------------------------------------------------------------------
	// Status codes
	// -------------------------------------------------------------------------

	it("GET /status/201 → custom 2xx status code", async () => {
		const res = await get("/status/201");
		expect(res.status).toBe(201);
	});

	it("GET /status/404 → custom 4xx status code", async () => {
		const res = await get("/status/404");
		expect(res.status).toBe(404);
	});

	// -------------------------------------------------------------------------
	// Error handling
	// -------------------------------------------------------------------------

	it("GET /error → unhandled handler throw becomes HTTP 500", async () => {
		const res = await get("/error");
		expect(res.status).toBe(500);
	});

	it("GET /unknown-route → app returns 404", async () => {
		const res = await get("/unknown-route");
		expect(res.status).toBe(404);
	});
});
