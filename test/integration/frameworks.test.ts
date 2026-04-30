/**
 * Framework integration tests for node-fastcgi.
 *
 * Each describe block mounts a real framework app behind serve(), sends
 * hand-crafted FastCGI bytes over TCP, and asserts on the HTTP response.
 * This validates that the FastCGI ↔ Web-standard Request/Response bridge
 * works correctly as a drop-in transport for popular frameworks.
 */

import type * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ServeResult } from "../../src/index.js";
import { serve } from "../../src/index.js";
import { fcgiRequest } from "./helpers.js";

// ---------------------------------------------------------------------------
// Shared server lifecycle
// ---------------------------------------------------------------------------

let server: ServeResult;
let port: number;

async function startServer(handler: (req: Request) => Response | Promise<Response>) {
	server = await serve(handler, { host: "127.0.0.1" });
	port = (server.address as net.AddressInfo).port;
}

afterEach(async () => {
	await server?.close();
});

// ===========================================================================
// Hono
// ===========================================================================

describe("Hono integration", () => {
	async function setup() {
		const { Hono } = await import("hono");

		const app = new Hono();

		app.get("/hello", (c) => {
			const name = c.req.query("name") ?? "World";
			return c.text(`Hello, ${name}!`);
		});

		app.get("/json", (c) => c.json({ framework: "hono", ok: true }));

		app.post("/echo", async (c) => {
			const body = await c.req.text();
			return c.text(body, 200);
		});

		app.post("/echo-json", async (c) => {
			const data = await c.req.json<{ value: string }>();
			return c.json({ received: data.value });
		});

		app.get("/params/:id", (c) => c.json({ id: c.req.param("id") }));

		app.get("/status/:code", (c) => {
			const code = Number(c.req.param("code"));
			return new Response(String(code), { status: code });
		});

		await startServer(app.fetch.bind(app));
	}

	it("routes a GET request and returns plain text", async () => {
		await setup();
		const res = await fcgiRequest({ port, path: "/hello" });
		expect(res.status).toBe(200);
		expect(res.body).toBe("Hello, World!");
	});

	it("reads query-string parameters", async () => {
		await setup();
		const res = await fcgiRequest({ port, path: "/hello?name=FastCGI" });
		expect(res.status).toBe(200);
		expect(res.body).toBe("Hello, FastCGI!");
	});

	it("returns a JSON response", async () => {
		await setup();
		const res = await fcgiRequest({ port, path: "/json" });
		expect(res.status).toBe(200);
		expect(res.headers["content-type"]).toMatch(/application\/json/);
		expect(JSON.parse(res.body)).toEqual({ framework: "hono", ok: true });
	});

	it("reads a POST body (text)", async () => {
		await setup();
		const res = await fcgiRequest({
			port,
			method: "POST",
			path: "/echo",
			headers: { "content-type": "text/plain" },
			body: "hello from fastcgi",
		});
		expect(res.status).toBe(200);
		expect(res.body).toBe("hello from fastcgi");
	});

	it("reads a POST body (JSON)", async () => {
		await setup();
		const res = await fcgiRequest({
			port,
			method: "POST",
			path: "/echo-json",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ value: "node-fastcgi" }),
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body)).toEqual({ received: "node-fastcgi" });
	});

	it("handles path parameters", async () => {
		await setup();
		const res = await fcgiRequest({ port, path: "/params/42" });
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body)).toEqual({ id: "42" });
	});

	it("forwards non-200 status codes", async () => {
		await setup();
		const res = await fcgiRequest({ port, path: "/status/418" });
		expect(res.status).toBe(418);
	});

	it("returns 404 for unknown routes", async () => {
		await setup();
		const res = await fcgiRequest({ port, path: "/does-not-exist" });
		expect(res.status).toBe(404);
	});
});

// ===========================================================================
// tRPC
// ===========================================================================

describe("tRPC integration", () => {
	async function setup() {
		const { initTRPC } = await import("@trpc/server");
		const { fetchRequestHandler } = await import("@trpc/server/adapters/fetch");
		const { z } = await import("zod");

		const t = initTRPC.create();

		const router = t.router({
			hello: t.procedure.query(() => ({ message: "Hello from tRPC!" })),

			greet: t.procedure
				.input(z.object({ name: z.string() }))
				.query(({ input }) => ({ message: `Hello, ${input.name}!` })),

			add: t.procedure
				.input(z.object({ a: z.number(), b: z.number() }))
				.mutation(({ input }) => ({ sum: input.a + input.b })),

			echo: t.procedure.input(z.string()).mutation(({ input }) => ({ echoed: input })),
		});

		const handler = (req: Request) =>
			fetchRequestHandler({ endpoint: "/trpc", req, router, createContext: () => ({}) });

		await startServer(handler);
	}

	it("calls a no-input query procedure", async () => {
		await setup();
		const res = await fcgiRequest({ port, path: "/trpc/hello" });
		expect(res.status).toBe(200);
		const data = JSON.parse(res.body) as { result: { data: { message: string } } };
		expect(data.result.data.message).toBe("Hello from tRPC!");
	});

	it("calls a query procedure with object input", async () => {
		await setup();
		const input = encodeURIComponent(JSON.stringify({ name: "FastCGI" }));
		const res = await fcgiRequest({ port, path: `/trpc/greet?input=${input}` });
		expect(res.status).toBe(200);
		const data = JSON.parse(res.body) as { result: { data: { message: string } } };
		expect(data.result.data.message).toBe("Hello, FastCGI!");
	});

	it("calls a mutation procedure with number inputs", async () => {
		await setup();
		const res = await fcgiRequest({
			port,
			method: "POST",
			path: "/trpc/add",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ a: 7, b: 3 }),
		});
		expect(res.status).toBe(200);
		const data = JSON.parse(res.body) as { result: { data: { sum: number } } };
		expect(data.result.data.sum).toBe(10);
	});

	it("calls a mutation procedure with string input", async () => {
		await setup();
		const res = await fcgiRequest({
			port,
			method: "POST",
			path: "/trpc/echo",
			headers: { "content-type": "application/json" },
			body: JSON.stringify("ping"),
		});
		expect(res.status).toBe(200);
		const data = JSON.parse(res.body) as { result: { data: { echoed: string } } };
		expect(data.result.data.echoed).toBe("ping");
	});

	it("returns a tRPC validation error for invalid input", async () => {
		await setup();
		const res = await fcgiRequest({
			port,
			method: "POST",
			path: "/trpc/add",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ a: "not-a-number", b: 3 }),
		});
		// tRPC returns 400 for input validation errors
		expect(res.status).toBe(400);
	});
});

// ===========================================================================
// h3 (Nitro's server engine)
// ===========================================================================

describe("h3 (Nitro) integration", () => {
	async function setup() {
		const { createApp, createRouter, defineEventHandler, readBody, getRouterParam } = await import(
			"h3"
		);

		const app = createApp();
		const router = createRouter();

		router.get(
			"/hello",
			defineEventHandler(() => ({ message: "Hello from h3!" })),
		);

		router.post(
			"/echo",
			defineEventHandler(async (event) => {
				const body = await readBody<{ text: string }>(event);
				return { echoed: body?.text ?? "" };
			}),
		);

		router.get(
			"/headers",
			defineEventHandler((event) => {
				const custom = event.req.headers.get("x-custom") ?? "(none)";
				return { "x-custom": custom };
			}),
		);

		router.get(
			"/status/:code",
			defineEventHandler((event) => {
				const code = Number(getRouterParam(event, "code") ?? 200);
				event.res.status = code;
				return { status: code };
			}),
		);

		app.use(router);
		await startServer(app.fetch.bind(app));
	}

	it("routes a GET request and returns JSON", async () => {
		await setup();
		const res = await fcgiRequest({ port, path: "/hello" });
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body)).toEqual({ message: "Hello from h3!" });
	});

	it("reads a POST body and echoes it", async () => {
		await setup();
		const res = await fcgiRequest({
			port,
			method: "POST",
			path: "/echo",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "hello h3" }),
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body)).toEqual({ echoed: "hello h3" });
	});

	it("forwards custom request headers", async () => {
		await setup();
		const res = await fcgiRequest({
			port,
			path: "/headers",
			headers: { "x-custom": "my-value" },
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body)).toEqual({ "x-custom": "my-value" });
	});

	it("sets a custom response status code", async () => {
		await setup();
		const res = await fcgiRequest({ port, path: "/status/201" });
		expect(res.status).toBe(201);
		expect(JSON.parse(res.body)).toEqual({ status: 201 });
	});

	it("returns 404 for unknown routes", async () => {
		await setup();
		const res = await fcgiRequest({ port, path: "/does-not-exist" });
		expect(res.status).toBe(404);
	});
});
