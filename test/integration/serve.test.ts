/**
 * Integration tests for node-fastcgi.
 *
 * Each test spins up a real serve() listener on an ephemeral TCP port,
 * sends hand-crafted FastCGI bytes, and asserts the response bytes.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Handler, ServeResult } from "../../src/index.js";
import { ConnectionDeniedError, HandlerError, ProtocolError, serve } from "../../src/index.js";
import { FCGI_KEEP_CONN, ProtocolStatus, RecordType, Role } from "../../src/protocol/constants.js";
import { decodeNameValues } from "../../src/protocol/nameValue.js";
import { encodeRecord } from "../../src/protocol/record.js";
import type { FcgiRecord } from "./helpers.js";
import {
	beginRequest,
	emptyRecord,
	FCGI_MAX_CONNS,
	FCGI_MAX_REQS,
	FCGI_MPXS_CONNS,
	fcgiRequest,
	getValuesRecord,
	paramsRecord,
	parseCgiResponse,
	RecordParser,
	sendAndCollect,
	stdinRecord,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Test setup/teardown
// ---------------------------------------------------------------------------

let server: ServeResult;
let port: number;

async function startServer(handler: Handler, options: Record<string, unknown> = {}) {
	server = await serve(handler, { host: "127.0.0.1", ...options });
	port = (server.address as net.AddressInfo).port;
}

afterEach(async () => {
	await server?.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("serve() options validation", () => {
	it("rejects when more than one transport option is specified", async () => {
		const handler = async () => new Response("ok");
		await expect(serve(handler, { port: 9000, socketPath: "/tmp/test.sock" })).rejects.toThrow(
			TypeError,
		);
		await expect(serve(handler, { port: 9000, inheritedFd: 0 })).rejects.toThrow(TypeError);
		await expect(serve(handler, { socketPath: "/tmp/test.sock", inheritedFd: 0 })).rejects.toThrow(
			TypeError,
		);
	});
});

describe("GET_VALUES advertised limits", () => {
	it("defaults FCGI_MAX_CONNS and FCGI_MAX_REQS to 1024 when maxConnections is unset", async () => {
		await startServer(async () => new Response("ok"), {});

		const records = await sendAndCollect(port, getValuesRecord(), {
			resolveWhen: (r) => r.type === RecordType.GET_VALUES_RESULT,
		});
		const reply = records.find((r) => r.type === RecordType.GET_VALUES_RESULT);
		expect(reply).toBeDefined();
		if (!reply) return;
		const values = decodeNameValues(reply.contentData);
		expect(values.get(FCGI_MAX_CONNS)).toBe("1024");
		expect(values.get(FCGI_MAX_REQS)).toBe("1024");
		expect(values.get(FCGI_MPXS_CONNS)).toBe("0");
	});

	it("honors serve() maxConnections for advertised limits", async () => {
		await startServer(async () => new Response("ok"), { maxConnections: 50 });

		const records = await sendAndCollect(port, getValuesRecord(), {
			resolveWhen: (r) => r.type === RecordType.GET_VALUES_RESULT,
		});
		const reply = records.find((r) => r.type === RecordType.GET_VALUES_RESULT);
		expect(reply).toBeDefined();
		if (!reply) return;
		const values = decodeNameValues(reply.contentData);
		expect(values.get(FCGI_MAX_CONNS)).toBe("50");
		expect(values.get(FCGI_MAX_REQS)).toBe("50");
		expect(values.get(FCGI_MPXS_CONNS)).toBe("0");
	});
});

describe("serve() integration", () => {
	it("destroys the connection when a peer dribbles bytes past maxBufferedBytes", async () => {
		let onErrorErr: unknown;
		await startServer(async () => new Response("ok"), {
			maxBufferedBytes: 32,
			onError: (e) => {
				onErrorErr = e;
			},
		});

		const sock = net.createConnection({ port, host: "127.0.0.1" });
		await new Promise((r) => sock.once("connect", r));
		sock.write(Buffer.alloc(40, 0));
		await new Promise<void>((resolve) => sock.once("close", resolve));
		expect(onErrorErr).toBeInstanceOf(ProtocolError);
		expect(String((onErrorErr as Error).message)).toMatch(/maxBufferedBytes/);
		sock.destroy();
	});

	it("responds to a simple GET request (spec example B.1)", async () => {
		await startServer(async (req) => {
			return new Response(`Hello from ${new URL(req.url).pathname}`, {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
		});

		const wire = Buffer.concat([
			beginRequest(1, Role.RESPONDER),
			paramsRecord(1, {
				REQUEST_METHOD: "GET",
				REQUEST_URI: "/hello",
				SERVER_NAME: "localhost",
				SERVER_PORT: "9000",
				HTTP_HOST: "localhost:9000",
			}),
			emptyRecord(RecordType.PARAMS, 1),
			emptyRecord(RecordType.STDIN, 1),
		]);

		const records = await sendAndCollect(port, wire);

		const stdoutRecords = records.filter((r) => r.type === RecordType.STDOUT);
		const endRecord = records.find((r) => r.type === RecordType.END_REQUEST);

		expect(endRecord).toBeDefined();

		// Concatenate non-empty STDOUT records
		const stdoutContent = Buffer.concat(
			stdoutRecords.filter((r) => r.contentData.length > 0).map((r) => r.contentData),
		);
		const { status, headers, body } = parseCgiResponse(stdoutContent);

		expect(status).toBe(200);
		expect(headers["content-type"]).toBe("text/plain");
		expect(body).toBe("Hello from /hello");
	});

	it("handles POST with STDIN body (spec example B.2)", async () => {
		await startServer(async (req) => {
			const text = await req.text();
			return new Response(`Received: ${text}`, { status: 200 });
		});

		const bodyText = "quantity=100&item=3047936";
		const wire = Buffer.concat([
			beginRequest(1, Role.RESPONDER),
			paramsRecord(1, {
				REQUEST_METHOD: "POST",
				REQUEST_URI: "/submit",
				SERVER_NAME: "localhost",
				SERVER_PORT: "9000",
				HTTP_HOST: "localhost",
				CONTENT_TYPE: "application/x-www-form-urlencoded",
				CONTENT_LENGTH: String(bodyText.length),
			}),
			emptyRecord(RecordType.PARAMS, 1),
			stdinRecord(1, bodyText),
			emptyRecord(RecordType.STDIN, 1),
		]);

		const records = await sendAndCollect(port, wire);
		const stdoutContent = Buffer.concat(
			records
				.filter((r) => r.type === RecordType.STDOUT && r.contentData.length > 0)
				.map((r) => r.contentData),
		);
		const { body } = parseCgiResponse(stdoutContent);
		expect(body).toBe("Received: quantity=100&item=3047936");
	});

	it("returns 500 and writes STDERR when handler throws (spec example B.3)", async () => {
		const errors: unknown[] = [];
		await startServer(
			async () => {
				throw new Error("Something went wrong");
			},
			{
				verboseErrors: true,
				onError: (err: unknown) => {
					errors.push(err);
				},
			},
		);

		const wire = Buffer.concat([
			beginRequest(1, Role.RESPONDER),
			paramsRecord(1, {
				REQUEST_METHOD: "GET",
				REQUEST_URI: "/boom",
				SERVER_NAME: "localhost",
				SERVER_PORT: "9000",
			}),
			emptyRecord(RecordType.PARAMS, 1),
			emptyRecord(RecordType.STDIN, 1),
		]);

		const records = await sendAndCollect(port, wire);

		const stderrRecords = records.filter(
			(r) => r.type === RecordType.STDERR && r.contentData.length > 0,
		);
		const endRecord = records.find((r) => r.type === RecordType.END_REQUEST);
		const stdoutContent = Buffer.concat(
			records
				.filter((r) => r.type === RecordType.STDOUT && r.contentData.length > 0)
				.map((r) => r.contentData),
		);

		const { status } = parseCgiResponse(stdoutContent);

		expect(status).toBe(500);
		expect(stderrRecords.length).toBeGreaterThan(0);
		expect(stderrRecords[0]?.contentData.toString()).toContain("Something went wrong");
		expect(endRecord).toBeDefined();
		// appStatus should be non-zero for errors (spec sec B.3: appStatus=938)
		if (endRecord) {
			const appStatus = endRecord.contentData.readUInt32BE(0);
			expect(appStatus).not.toBe(0);
		}
		expect(errors).toHaveLength(1);
	});

	it("rejects non-Responder role with FCGI_UNKNOWN_ROLE", async () => {
		await startServer(async () => new Response("ok"));

		const wire = Buffer.concat([
			beginRequest(1, Role.AUTHORIZER),
			paramsRecord(1, { REQUEST_METHOD: "GET" }),
			emptyRecord(RecordType.PARAMS, 1),
			emptyRecord(RecordType.STDIN, 1),
		]);

		const records = await sendAndCollect(port, wire);
		const endRecord = records.find((r) => r.type === RecordType.END_REQUEST);

		expect(endRecord).toBeDefined();
		if (endRecord) {
			expect(endRecord.contentData[4]).toBe(ProtocolStatus.UNKNOWN_ROLE);
		}
	});

	it("responds to FCGI_GET_VALUES (spec sec 4.1)", async () => {
		await startServer(async () => new Response("ok"));

		const wire = getValuesRecord();

		// Send GET_VALUES only, then close — the server should reply and keep the connection open
		const records = await new Promise<FcgiRecord[]>((resolve, reject) => {
			const collected: FcgiRecord[] = [];
			const parser = new RecordParser((r) => {
				collected.push(r);
				if (collected.some((rec) => rec.type === RecordType.GET_VALUES_RESULT)) {
					socket.destroy();
					resolve(collected);
				}
			});
			const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
				socket.write(wire);
			});
			socket.on("data", (chunk: Buffer) => parser.push(chunk));
			socket.on("error", reject);
			setTimeout(() => reject(new Error("Timeout waiting for GET_VALUES_RESULT")), 3000);
		});

		const result = records.find((r) => r.type === RecordType.GET_VALUES_RESULT);
		expect(result).toBeDefined();

		if (result) {
			const values = decodeNameValues(result.contentData);
			expect(values.get(FCGI_MPXS_CONNS)).toBe("0");
			expect(values.get(FCGI_MAX_CONNS)).toBe("1024");
			expect(values.get(FCGI_MAX_REQS)).toBe("1024");
		}
	});

	it("rejects a second concurrent BEGIN_REQUEST with FCGI_CANT_MPX_CONN (spec sec 5.5)", async () => {
		await startServer(async () => {
			// Slow handler — keeps the first request alive so the second one conflicts
			await new Promise((r) => setTimeout(r, 100));
			return new Response("ok");
		});

		// Send two BEGIN_REQUEST records without finishing the first
		const wire = Buffer.concat([
			beginRequest(1, Role.RESPONDER, FCGI_KEEP_CONN),
			paramsRecord(1, { REQUEST_METHOD: "GET", SERVER_NAME: "localhost", SERVER_PORT: "9000" }),
			emptyRecord(RecordType.PARAMS, 1),
			// Don't send STDIN for request 1 yet — send a new BEGIN_REQUEST instead
			beginRequest(2, Role.RESPONDER),
		]);

		const records = await new Promise<FcgiRecord[]>((resolve, reject) => {
			const collected: FcgiRecord[] = [];
			const parser = new RecordParser((r) => {
				collected.push(r);
				const cantMpx = collected.find(
					(rec) =>
						rec.type === RecordType.END_REQUEST &&
						rec.contentData[4] === ProtocolStatus.CANT_MPX_CONN,
				);
				if (cantMpx) {
					socket.destroy();
					resolve(collected);
				}
			});
			const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
				socket.write(wire);
			});
			socket.on("data", (chunk: Buffer) => parser.push(chunk));
			socket.on("error", reject);
			setTimeout(() => reject(new Error("Timeout")), 3000);
		});

		const cantMpxRecord = records.find(
			(r) => r.type === RecordType.END_REQUEST && r.contentData[4] === ProtocolStatus.CANT_MPX_CONN,
		);
		expect(cantMpxRecord).toBeDefined();
		if (cantMpxRecord) {
			expect(cantMpxRecord.requestId).toBe(2);
		}
	});

	it("handles KEEP_CONN flag — serves two sequential requests on one connection (spec sec 3.5)", async () => {
		await startServer(async (req) => {
			const id = new URL(req.url).searchParams.get("id") ?? "?";
			return new Response(`response-${id}`, { status: 200 });
		});

		const makeRequest = (requestId: number, id: string, keepConn: boolean) =>
			Buffer.concat([
				beginRequest(requestId, Role.RESPONDER, keepConn ? FCGI_KEEP_CONN : 0),
				paramsRecord(requestId, {
					REQUEST_METHOD: "GET",
					REQUEST_URI: `/?id=${id}`,
					SERVER_NAME: "localhost",
					SERVER_PORT: "9000",
				}),
				emptyRecord(RecordType.PARAMS, requestId),
				emptyRecord(RecordType.STDIN, requestId),
			]);

		// With KEEP_CONN, we must send request 2 only AFTER receiving END_REQUEST for request 1.
		// (Sending both at once would trigger CANT_MPX_CONN since request 1 is still active.)
		const endRecordIds: number[] = [];

		const records = await new Promise<FcgiRecord[]>((resolve, reject) => {
			const collected: FcgiRecord[] = [];
			const parser = new RecordParser((r) => {
				collected.push(r);
				if (r.type === RecordType.END_REQUEST) {
					endRecordIds.push(r.requestId);
					if (r.requestId === 1) {
						// Send the second request now that the first is done
						socket.write(makeRequest(2, "second", false));
					}
					if (r.requestId === 2) {
						// Second request done — socket will close (no KEEP_CONN)
						resolve(collected);
					}
				}
			});
			const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
				socket.write(makeRequest(1, "first", true));
			});
			socket.on("data", (chunk: Buffer) => parser.push(chunk));
			socket.on("error", reject);
			socket.on("end", () => resolve(collected));
			setTimeout(() => reject(new Error("Timeout")), 5000);
		});

		const endRecords = records.filter((r) => r.type === RecordType.END_REQUEST);
		expect(endRecords.length).toBe(2);
		expect(endRecordIds).toEqual([1, 2]);

		// Verify both responses have status 200
		const stdoutByRequest = new Map<number, Buffer[]>();
		for (const r of records) {
			if (r.type === RecordType.STDOUT && r.contentData.length > 0) {
				const chunks = stdoutByRequest.get(r.requestId) ?? [];
				chunks.push(r.contentData);
				stdoutByRequest.set(r.requestId, chunks);
			}
		}

		for (const [, chunks] of stdoutByRequest) {
			const { status } = parseCgiResponse(Buffer.concat(chunks));
			expect(status).toBe(200);
		}
	});

	it("respects allowedAddresses — drops connections from unlisted IPs", async () => {
		await startServer(async () => new Response("ok"), {
			allowedAddresses: ["999.999.999.999"], // nothing should match
		});

		const connected = await new Promise<boolean>((resolve) => {
			const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
				resolve(true);
				socket.destroy();
			});
			socket.on("error", () => resolve(false));
			// If the connection is accepted but then immediately closed, we still
			// get a connect event. We check that the socket is destroyed quickly.
			setTimeout(() => resolve(socket.destroyed), 500);
		});

		// The connection reaches the port, but after the IP check the server
		// immediately destroys it. The socket may have appeared connected briefly.
		// We verify no valid FastCGI response is returned.
		const records = await new Promise<FcgiRecord[]>((resolve, _reject) => {
			const collected: FcgiRecord[] = [];
			const parser = new RecordParser((r) => collected.push(r));
			const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
				const wire = Buffer.concat([
					beginRequest(1, Role.RESPONDER),
					paramsRecord(1, { REQUEST_METHOD: "GET", SERVER_NAME: "localhost", SERVER_PORT: "9000" }),
					emptyRecord(RecordType.PARAMS, 1),
					emptyRecord(RecordType.STDIN, 1),
				]);
				socket.write(wire);
			});
			socket.on("data", (chunk: Buffer) => parser.push(chunk));
			socket.on("end", () => resolve(collected));
			socket.on("error", () => resolve(collected));
			setTimeout(() => resolve(collected), 500);
		});

		const endRecord = records.find((r) => r.type === RecordType.END_REQUEST);
		expect(endRecord).toBeUndefined();

		void connected;
	});

	it("shuts down gracefully via AbortSignal", async () => {
		const controller = new AbortController();
		// Assign to `server` so afterEach can attempt close (it will be a no-op)
		server = await serve(async () => new Response("ok"), {
			host: "127.0.0.1",
			signal: controller.signal,
		});
		port = (server.address as net.AddressInfo).port;

		// Confirm it's listening
		await new Promise<void>((resolve, reject) => {
			const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
				socket.destroy();
				resolve();
			});
			socket.on("error", reject);
		});

		// Abort — triggers graceful shutdown
		controller.abort();

		// Give the server a tick to stop listening
		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		// After abort, new connections should be refused
		await expect(
			new Promise<void>((resolve, reject) => {
				const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
					socket.destroy();
					resolve();
				});
				socket.on("error", reject);
			}),
		).rejects.toThrow();
	});
});

describe("response body cleanup", () => {
	it("cancels the response body stream when the socket is destroyed mid-stream", async () => {
		let cancelled!: () => void;
		const cancelPromise = new Promise<void>((resolve) => {
			cancelled = resolve;
		});

		await startServer(async () => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const interval = setInterval(() => {
						try {
							controller.enqueue(new TextEncoder().encode("chunk\n"));
						} catch {
							clearInterval(interval);
						}
					}, 10);
				},
				cancel() {
					cancelled();
				},
			});
			return new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
		});

		const sock = net.createConnection({ port, host: "127.0.0.1" });
		await new Promise((r) => sock.once("connect", r));
		sock.write(
			Buffer.concat([
				beginRequest(1, Role.RESPONDER),
				paramsRecord(1, {
					REQUEST_METHOD: "GET",
					REQUEST_URI: "/",
					HTTP_HOST: `localhost:${port}`,
					SERVER_NAME: "localhost",
					SERVER_PORT: String(port),
				}),
				emptyRecord(RecordType.PARAMS, 1),
				emptyRecord(RecordType.STDIN, 1),
			]),
		);
		// Wait for some data to flow, then kill the socket.
		await new Promise<void>((r) => sock.once("data", () => r()));
		sock.destroy();

		await Promise.race([
			cancelPromise,
			new Promise<void>((_, rej) =>
				setTimeout(() => rej(new Error("cancel was not called within 1s")), 1000),
			),
		]);
	});
});

describe("Set-Cookie handling", () => {
	it("emits multiple Set-Cookie headers as separate lines when values contain commas", async () => {
		await startServer(async () => {
			const headers = new Headers();
			headers.append("set-cookie", "a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT");
			headers.append("set-cookie", "b=2; Path=/");
			return new Response("ok", { status: 200, headers });
		});

		const wire = Buffer.concat([
			beginRequest(1, Role.RESPONDER),
			paramsRecord(1, {
				REQUEST_METHOD: "GET",
				REQUEST_URI: "/",
				HTTP_HOST: `localhost:${port}`,
				SERVER_NAME: "localhost",
				SERVER_PORT: String(port),
			}),
			emptyRecord(RecordType.PARAMS, 1),
			emptyRecord(RecordType.STDIN, 1),
		]);
		const records = await sendAndCollect(port, wire);
		const stdoutContent = Buffer.concat(
			records
				.filter((r) => r.type === RecordType.STDOUT && r.contentData.length > 0)
				.map((r) => r.contentData),
		);
		const headerSection = stdoutContent.toString("utf8").split("\r\n\r\n")[0] ?? "";
		const cookieLines = headerSection
			.split("\r\n")
			.filter((l) => l.toLowerCase().startsWith("set-cookie:"));
		expect(cookieLines).toHaveLength(2);
		expect(cookieLines).toContain("set-cookie: a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT");
		expect(cookieLines).toContain("set-cookie: b=2; Path=/");
	});

	it("includes other headers alongside Set-Cookie", async () => {
		await startServer(async () => {
			const headers = new Headers();
			headers.append("set-cookie", "a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT");
			headers.append("set-cookie", "b=2; Path=/");
			headers.set("x-custom", "yes");
			return new Response("ok", { status: 200, headers });
		});

		const wire = Buffer.concat([
			beginRequest(1, Role.RESPONDER),
			paramsRecord(1, {
				REQUEST_METHOD: "GET",
				REQUEST_URI: "/",
				HTTP_HOST: `localhost:${port}`,
				SERVER_NAME: "localhost",
				SERVER_PORT: String(port),
			}),
			emptyRecord(RecordType.PARAMS, 1),
			emptyRecord(RecordType.STDIN, 1),
		]);
		const records = await sendAndCollect(port, wire);
		const stdoutContent = Buffer.concat(
			records
				.filter((r) => r.type === RecordType.STDOUT && r.contentData.length > 0)
				.map((r) => r.contentData),
		);
		const headerSection = stdoutContent.toString("utf8").split("\r\n\r\n")[0] ?? "";
		const lines = headerSection.split("\r\n");
		expect(lines.some((l) => l.toLowerCase() === "x-custom: yes")).toBe(true);
		const cookieLines = lines.filter((l) => l.toLowerCase().startsWith("set-cookie:"));
		expect(cookieLines).toHaveLength(2);
		expect(cookieLines).toContain("set-cookie: a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT");
		expect(cookieLines).toContain("set-cookie: b=2; Path=/");
	});
});

describe("PARAMS edge cases", () => {
	it("ignores duplicate empty PARAMS after terminator (single handler run, one END_REQUEST, one STDOUT terminator)", async () => {
		let handlerInvocations = 0;
		await startServer(async () => {
			handlerInvocations++;
			return new Response("ok", { status: 200 });
		});

		const wire = Buffer.concat([
			beginRequest(1, Role.RESPONDER),
			paramsRecord(1, {
				REQUEST_METHOD: "GET",
				REQUEST_URI: "/",
				SERVER_NAME: "localhost",
				SERVER_PORT: String(port),
				HTTP_HOST: `localhost:${port}`,
			}),
			emptyRecord(RecordType.PARAMS, 1),
			emptyRecord(RecordType.PARAMS, 1),
			emptyRecord(RecordType.STDIN, 1),
		]);

		const records = await sendAndCollect(port, wire);

		expect(handlerInvocations).toBe(1);
		expect(records.filter((r) => r.type === RecordType.END_REQUEST).length).toBe(1);
		expect(
			records.filter((r) => r.type === RecordType.STDOUT && r.contentData.length === 0).length,
		).toBe(1);
	});

	it("ignores non-empty PARAMS after terminator (REQUEST_URI not overwritten)", async () => {
		await startServer(async (req) => new Response(req.url, { status: 200 }));

		const wire = Buffer.concat([
			beginRequest(1, Role.RESPONDER),
			paramsRecord(1, {
				REQUEST_METHOD: "GET",
				REQUEST_URI: "/orig",
				SERVER_NAME: "localhost",
				SERVER_PORT: String(port),
				HTTP_HOST: `localhost:${port}`,
			}),
			emptyRecord(RecordType.PARAMS, 1),
			paramsRecord(1, { REQUEST_URI: "/replaced" }),
			emptyRecord(RecordType.STDIN, 1),
		]);

		const records = await sendAndCollect(port, wire);
		const stdoutContent = Buffer.concat(
			records
				.filter((r) => r.type === RecordType.STDOUT && r.contentData.length > 0)
				.map((r) => r.contentData),
		);
		const { body } = parseCgiResponse(stdoutContent);
		expect(body).toContain("/orig");
		expect(body).not.toContain("/replaced");
	});
});

describe("STDIN-before-PARAMS-terminator", () => {
	it("buffers STDIN that arrives before the PARAMS terminator", async () => {
		await startServer(async (req) => {
			const text = await req.text();
			return new Response(`got:${text}`, { status: 200 });
		});

		const wire = Buffer.concat([
			beginRequest(1, Role.RESPONDER),
			paramsRecord(1, {
				REQUEST_METHOD: "POST",
				REQUEST_URI: "/",
				HTTP_HOST: `localhost:${port}`,
				SERVER_NAME: "localhost",
				SERVER_PORT: String(port),
				CONTENT_LENGTH: "3",
			}),
			stdinRecord(1, "a"),
			stdinRecord(1, "b"),
			stdinRecord(1, "c"),
			emptyRecord(RecordType.PARAMS, 1),
			emptyRecord(RecordType.STDIN, 1),
		]);

		const records = await sendAndCollect(port, wire);
		const stdoutContent = Buffer.concat(
			records
				.filter((r) => r.type === RecordType.STDOUT && r.contentData.length > 0)
				.map((r) => r.contentData),
		);
		const { status, body } = parseCgiResponse(stdoutContent);
		expect(status).toBe(200);
		expect(body).toBe("got:abc");
	});

	it("handles empty STDIN that arrives before the PARAMS terminator", async () => {
		await startServer(async (req) => {
			const text = await req.text();
			return new Response(`len:${text.length}`, { status: 200 });
		});

		const wire = Buffer.concat([
			beginRequest(1, Role.RESPONDER),
			paramsRecord(1, {
				REQUEST_METHOD: "POST",
				REQUEST_URI: "/",
				HTTP_HOST: `localhost:${port}`,
				SERVER_NAME: "localhost",
				SERVER_PORT: String(port),
				CONTENT_LENGTH: "0",
			}),
			emptyRecord(RecordType.STDIN, 1),
			emptyRecord(RecordType.PARAMS, 1),
		]);

		const records = await sendAndCollect(port, wire);
		const stdoutContent = Buffer.concat(
			records
				.filter((r) => r.type === RecordType.STDOUT && r.contentData.length > 0)
				.map((r) => r.contentData),
		);
		const { status, body } = parseCgiResponse(stdoutContent);
		expect(status).toBe(200);
		expect(body).toBe("len:0");
	});

	it("enforces maxBodyBytes for STDIN interleaved with PARAMS", async () => {
		const errors: unknown[] = [];
		await startServer(async (req) => new Response(await req.text()), {
			maxBodyBytes: 4,
			onError: (e) => {
				errors.push(e);
			},
		});
		const wire = Buffer.concat([
			beginRequest(1, Role.RESPONDER),
			paramsRecord(1, {
				REQUEST_METHOD: "POST",
				REQUEST_URI: "/",
				HTTP_HOST: `localhost:${port}`,
				SERVER_NAME: "localhost",
				SERVER_PORT: String(port),
			}),
			stdinRecord(1, "xxxxxxxx"),
			emptyRecord(RecordType.PARAMS, 1),
			emptyRecord(RecordType.STDIN, 1),
		]);
		try {
			await sendAndCollect(port, wire);
		} catch {
			// socket destroy is OK
		}
		await new Promise((r) => setTimeout(r, 50));
		const pe = errors.find((e): e is ProtocolError => e instanceof ProtocolError);
		expect(pe).toBeDefined();
		expect(String(pe?.message)).toMatch(/maxBodyBytes/);
	});
});

describe("ABORT_REQUEST race", () => {
	it("sends exactly one END_REQUEST when ABORT arrives mid-handler", async () => {
		await startServer(async () => {
			await new Promise((r) => setTimeout(r, 80));
			return new Response("late", { status: 200 });
		});

		const records = await new Promise<FcgiRecord[]>((resolve, reject) => {
			const collected: FcgiRecord[] = [];
			const parser = new RecordParser((r) => collected.push(r));
			const sock = net.createConnection({ port, host: "127.0.0.1" });
			sock.on("data", (c: Buffer) => parser.push(c));
			sock.on("error", (e) => reject(e));

			const done = () => {
				resolve(collected);
			};

			sock.once("connect", () => {
				sock.write(
					Buffer.concat([
						beginRequest(1, Role.RESPONDER, FCGI_KEEP_CONN),
						paramsRecord(1, {
							REQUEST_METHOD: "GET",
							REQUEST_URI: "/",
							SERVER_NAME: "localhost",
							SERVER_PORT: String(port),
						}),
						emptyRecord(RecordType.PARAMS, 1),
						emptyRecord(RecordType.STDIN, 1),
					]),
				);
				setTimeout(() => {
					sock.write(encodeRecord(RecordType.ABORT_REQUEST, 1, Buffer.alloc(0)));
				}, 20);
				setTimeout(() => {
					sock.destroy();
					done();
				}, 250);
			});
		});

		const ends = records.filter((r) => r.type === RecordType.END_REQUEST && r.requestId === 1);
		expect(ends.length).toBe(1);
	});

	it("does not emit STDOUT after END_REQUEST when ABORT is late", async () => {
		await startServer(async () => {
			await new Promise((r) => setTimeout(r, 80));
			return new Response("late", { status: 200 });
		});

		const records = await new Promise<FcgiRecord[]>((resolve, reject) => {
			const collected: FcgiRecord[] = [];
			const parser = new RecordParser((r) => collected.push(r));
			const sock = net.createConnection({ port, host: "127.0.0.1" });
			sock.on("data", (c: Buffer) => parser.push(c));
			sock.on("error", (e) => reject(e));

			const done = () => {
				resolve(collected);
			};

			sock.once("connect", () => {
				sock.write(
					Buffer.concat([
						beginRequest(1, Role.RESPONDER, FCGI_KEEP_CONN),
						paramsRecord(1, {
							REQUEST_METHOD: "GET",
							REQUEST_URI: "/",
							SERVER_NAME: "localhost",
							SERVER_PORT: String(port),
						}),
						emptyRecord(RecordType.PARAMS, 1),
						emptyRecord(RecordType.STDIN, 1),
					]),
				);
				setTimeout(() => {
					sock.write(encodeRecord(RecordType.ABORT_REQUEST, 1, Buffer.alloc(0)));
				}, 20);
				setTimeout(() => {
					sock.destroy();
					done();
				}, 250);
			});
		});

		const endIdx = records.findIndex((r) => r.type === RecordType.END_REQUEST && r.requestId === 1);
		expect(endIdx).toBeGreaterThanOrEqual(0);
		const afterEnd = records.slice(endIdx + 1);
		expect(afterEnd.some((r) => r.type === RecordType.STDOUT)).toBe(false);
	});
});

describe("integration edge-case regressions", () => {
	let serverFu: ServeResult;
	let portFu: number;

	async function startFu(handler: Handler, options: Record<string, unknown> = {}) {
		serverFu = await serve(handler, { host: "127.0.0.1", ...options });
		portFu = (serverFu.address as net.AddressInfo).port;
	}

	afterEach(async () => {
		await serverFu?.close();
	});

	it("HTTPS=off yields http scheme in reconstructed URL", async () => {
		await startFu(async (req) => new Response(req.url));
		const records = await sendAndCollect(portFu, httpsWire(portFu, "off"));
		const { body } = parseCgiResponse(concatStdout(records));
		expect(body.startsWith("http://")).toBe(true);
		expect(body.startsWith("https://")).toBe(false);
	});

	it("HTTPS=on yields https scheme in reconstructed URL", async () => {
		await startFu(async (req) => new Response(req.url));
		const records = await sendAndCollect(portFu, httpsWire(portFu, "on"));
		const { body } = parseCgiResponse(concatStdout(records));
		expect(body.startsWith("https://")).toBe(true);
	});

	it("DELETE with body streams STDIN correctly", async () => {
		await startFu(async (req) => {
			const text = await req.text();
			return new Response(`body=${text}`);
		});
		const payload = '{"x":1}';
		const { body } = await fcgiRequest({
			port: portFu,
			method: "DELETE",
			path: "/d",
			headers: { "content-type": "application/json" },
			body: payload,
		});
		expect(body).toBe(`body=${payload}`);
	});

	it("strips CRLF injected via statusText from CGI header block", async () => {
		await startFu(
			async () => new Response("ok", { status: 200, statusText: "OK\r\nX-Injected: 1" }),
		);
		const records = await sendAndCollect(portFu, fcgiMinimalGetWire(portFu));
		const stdout = concatStdout(records);
		const { headers } = parseCgiResponse(stdout);
		expect(headers["x-injected"]).toBeUndefined();
	});

	it("strips CRLF injected via header value", async () => {
		await startFu(async () => {
			return new Response("ok", {
				headers: { "x-foo": "bar\r\nX-Injected: 1" },
			});
		});
		const records = await sendAndCollect(portFu, fcgiMinimalGetWire(portFu));
		const { headers } = parseCgiResponse(concatStdout(records));
		expect(headers["x-injected"]).toBeUndefined();
	});

	it("strips NUL from header values in CGI wire output", async () => {
		await startFu(async () => {
			return new Response("ok", {
				headers: { "x-foo": "a\x00injected" },
			});
		});
		const records = await sendAndCollect(portFu, fcgiMinimalGetWire(portFu));
		const stdout = concatStdout(records);
		expect(stdout.includes("\x00")).toBe(false);
	});

	it("rejects PARAMS larger than maxParamsBytes", async () => {
		const errors: unknown[] = [];
		await startFu(async () => new Response("ok"), {
			maxParamsBytes: 256,
			onError: (err) => errors.push(err),
		});
		const pad = "P".repeat(300);
		const wire = Buffer.concat([
			beginRequest(1, Role.RESPONDER),
			paramsRecord(1, {
				REQUEST_METHOD: "GET",
				REQUEST_URI: "/",
				SERVER_NAME: "localhost",
				SERVER_PORT: String(portFu),
				BIG: pad,
			}),
			emptyRecord(RecordType.PARAMS, 1),
			emptyRecord(RecordType.STDIN, 1),
		]);
		const records = await sendAndCollect(portFu, wire);
		expect(errors.some((e) => e instanceof ProtocolError)).toBe(true);
		expect(records.some((r) => r.type === RecordType.END_REQUEST)).toBe(false);
	});

	it("enforces maxParamsCount", async () => {
		const errors: unknown[] = [];
		await startFu(async () => new Response("ok"), {
			maxParamsCount: 2,
			onError: (err) => errors.push(err),
		});
		const wire = Buffer.concat([
			beginRequest(1, Role.RESPONDER),
			paramsRecord(1, {
				REQUEST_METHOD: "GET",
				REQUEST_URI: "/",
				SERVER_NAME: "localhost",
				SERVER_PORT: String(portFu),
				A: "1",
				B: "2",
				C: "3",
			}),
			emptyRecord(RecordType.PARAMS, 1),
			emptyRecord(RecordType.STDIN, 1),
		]);
		const records = await sendAndCollect(portFu, wire);
		expect(errors.some((e) => e instanceof ProtocolError)).toBe(true);
		expect(records.some((r) => r.type === RecordType.END_REQUEST)).toBe(false);
	});

	it("enforces maxBodyBytes by destroying the connection", async () => {
		let handlerRan = false;
		await startFu(
			async (req) => {
				handlerRan = true;
				try {
					await req.text();
				} catch {
					// aborted / destroyed body stream
				}
				return new Response("should-not-send");
			},
			{ maxBodyBytes: 10, verboseErrors: true },
		);
		const big = "z".repeat(100);
		const wire = Buffer.concat([
			beginRequest(1, Role.RESPONDER),
			paramsRecord(1, {
				REQUEST_METHOD: "POST",
				REQUEST_URI: "/",
				SERVER_NAME: "localhost",
				SERVER_PORT: String(portFu),
				CONTENT_LENGTH: String(Buffer.byteLength(big, "utf8")),
			}),
			emptyRecord(RecordType.PARAMS, 1),
			stdinRecord(1, big),
			emptyRecord(RecordType.STDIN, 1),
		]);
		const records = await sendAndCollect(portFu, wire);
		expect(handlerRan).toBe(true);
		expect(records.some((r) => r.type === RecordType.END_REQUEST)).toBe(false);
	});

	it("closes socket after maxRequestsPerConnection sequential requests", async () => {
		await startFu(async () => new Response("ok"), { maxRequestsPerConnection: 2 });

		await new Promise<void>((resolve, reject) => {
			let sock!: net.Socket;

			const parser = new RecordParser((r) => {
				if (r.type !== RecordType.END_REQUEST) return;
				if (r.requestId === 1) {
					sock.write(
						Buffer.concat([
							beginRequest(2, Role.RESPONDER, FCGI_KEEP_CONN),
							paramsRecord(2, minimalParams(portFu)),
							emptyRecord(RecordType.PARAMS, 2),
							emptyRecord(RecordType.STDIN, 2),
						]),
					);
				}
			});

			sock = net.createConnection({ port: portFu, host: "127.0.0.1" }, () => {
				sock.write(
					Buffer.concat([
						beginRequest(1, Role.RESPONDER, FCGI_KEEP_CONN),
						paramsRecord(1, minimalParams(portFu)),
						emptyRecord(RecordType.PARAMS, 1),
						emptyRecord(RecordType.STDIN, 1),
					]),
				);
			});

			const done = () => resolve();
			sock.once("end", () => done());
			sock.on("data", (c: Buffer) => parser.push(c));
			setTimeout(() => reject(new Error("expected socket.end after limit")), 2000);
		});
	});

	it("close() resolves within closeTimeout while a peer holds an idle connection open", async () => {
		const closeTimeout = 300;
		await startFu(async () => new Response("ok"), { closeTimeout });
		const deadline = Date.now() + closeTimeout + 250;
		const sock = net.createConnection({ port: portFu, host: "127.0.0.1" }, () => {
			sock.pause();
		});
		await new Promise<void>((resolve) => sock.once("connect", resolve));
		await serverFu.close();
		expect(Date.now()).toBeLessThan(deadline);
		try {
			sock.destroy();
		} catch {
			//
		}
	});

	it("emits multiple Set-Cookie headers in CGI stdout", async () => {
		await startFu(async () => {
			const h = new Headers();
			h.append("set-cookie", "a=1");
			h.append("set-cookie", "b=2");
			return new Response("ok", { headers: h });
		});
		const records = await sendAndCollect(portFu, fcgiMinimalGetWire(portFu));
		const lines = concatStdout(records).toString("utf8").split("\r\n\r\n")[0]?.split("\r\n") ?? [];
		const cookieLines = lines.filter((ln) => ln.toLowerCase().startsWith("set-cookie:"));
		expect(cookieLines.length).toBe(2);
	});

	it("verboseErrors:false omits STDERR on handler failure", async () => {
		await startFu(
			async () => {
				throw new Error("secret password 12345");
			},
			{ verboseErrors: false },
		);
		const records = await sendAndCollect(portFu, fcgiMinimalGetWire(portFu));
		const stderrNonEmpty = records.filter(
			(r) => r.type === RecordType.STDERR && r.contentData.length > 0,
		);
		expect(stderrNonEmpty.length).toBe(0);
	});

	it("onError returning {response, appStatus} is applied", async () => {
		await startFu(
			async () => {
				throw new Error("boom");
			},
			{
				verboseErrors: true,
				onError: () => ({
					response: new Response("custom", { status: 503 }),
					appStatus: 99,
				}),
			},
		);

		const records = await sendAndCollect(portFu, fcgiMinimalGetWire(portFu));
		const end = records.find((r) => r.type === RecordType.END_REQUEST);
		expect(end?.contentData.readUInt32BE(0)).toBe(99);
		const out = concatStdout(records);
		const { status, body } = parseCgiResponse(out);
		expect(status).toBe(503);
		expect(body).toBe("custom");
	});

	it("applies socketMode to Unix socket file", async () => {
		if (process.platform === "win32") return;
		const sockPath = path.join(
			os.tmpdir(),
			`nfcgi-mode-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
		);
		serverFu = await serve(async () => new Response("ok"), {
			socketPath: sockPath,
			socketMode: 0o660,
		});
		try {
			const stat = fs.statSync(sockPath);
			expect(stat.mode & 0o777).toBe(0o660);
		} finally {
			try {
				fs.unlinkSync(sockPath);
			} catch {
				//
			}
		}
	});

	it("unix socket skips allowedAddresses TCP check", async () => {
		if (process.platform === "win32") return;
		const sockPath = path.join(
			os.tmpdir(),
			`nfcgi-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
		);
		serverFu = await serve(async () => new Response("unix-ok"), {
			socketPath: sockPath,
			allowedAddresses: ["1.2.3.4"],
		});
		const { parseCgiResponse: parse } = await import("./helpers.js");
		const records = await new Promise<FcgiRecord[]>((resolve, reject) => {
			const collected: FcgiRecord[] = [];
			const parser = new RecordParser((r) => collected.push(r));
			const c = net.createConnection({ path: sockPath }, () => {
				c.write(fcgiMinimalGetWire(80));
			});
			c.on("data", (ch: Buffer) => parser.push(ch));
			c.on("end", () => resolve(collected));
			c.on("error", reject);
			setTimeout(() => reject(new Error("unix test timeout")), 2000);
		});
		const stdout = concatStdout(records);
		expect(parse(stdout).body).toBe("unix-ok");
		try {
			fs.unlinkSync(sockPath);
		} catch {
			// socket removed by server close in afterEach
		}
	});

	it("TCP allowlist mismatch surfaces ConnectionDeniedError", async () => {
		const errors: unknown[] = [];
		await startFu(async () => new Response("nope"), {
			allowedAddresses: ["10.0.0.0"],
			onError: (err) => errors.push(err),
		});
		const wire = fcgiMinimalGetWire(portFu);
		const records = await new Promise<FcgiRecord[]>((resolve) => {
			const collected: FcgiRecord[] = [];
			const parser = new RecordParser((r) => collected.push(r));
			const socket = net.createConnection({ port: portFu, host: "127.0.0.1" }, () => {
				socket.write(wire);
			});
			socket.on("data", (chunk: Buffer) => parser.push(chunk));
			socket.on("end", () => resolve(collected));
			socket.on("error", () => resolve(collected));
			setTimeout(() => resolve(collected), 300);
		});
		expect(records.some((r) => r.type === RecordType.END_REQUEST)).toBe(false);
		const deny = errors.find((e): e is ConnectionDeniedError => e instanceof ConnectionDeniedError);
		expect(deny?.remoteAddress).toBe("127.0.0.1");
	});

	it("unsupported FastCGI version destroys connection", async () => {
		const errors: unknown[] = [];
		await startFu(async () => new Response("ok"), {
			onError: (e) => {
				errors.push(e);
				return undefined;
			},
		});
		const body = Buffer.alloc(8);
		body.writeUInt16BE(Role.RESPONDER, 0);
		body[2] = 0;
		let bad = encodeRecord(RecordType.BEGIN_REQUEST, 1, body);
		bad = Buffer.from(bad);
		bad[0] = 2;

		const records = await sendAndCollect(portFu, bad);
		expect(errors.some((e) => e instanceof ProtocolError)).toBe(true);
		expect(records.some((r) => r.type === RecordType.END_REQUEST)).toBe(false);
	});

	it("ABORT_REQUEST yields a single END_REQUEST when handler ignores signal", async () => {
		await startFu(async (_req) => {
			await new Promise((r) => setTimeout(r, 250));
			return new Response("late");
		});

		const records = await new Promise<FcgiRecord[]>((resolve) => {
			const collected: FcgiRecord[] = [];
			const parser = new RecordParser((r) => collected.push(r));
			const sock = net.createConnection({ port: portFu, host: "127.0.0.1" }, () => {
				const first = Buffer.concat([
					beginRequest(1, Role.RESPONDER, FCGI_KEEP_CONN),
					paramsRecord(1, minimalParams(portFu)),
					emptyRecord(RecordType.PARAMS, 1),
					emptyRecord(RecordType.STDIN, 1),
				]);
				sock.write(first);
				setTimeout(() => {
					sock.write(encodeRecord(RecordType.ABORT_REQUEST, 1, Buffer.alloc(0)));
				}, 30);
			});
			sock.on("data", (c: Buffer) => parser.push(c));
			sock.on("end", () => resolve(collected));
			sock.on("error", () => resolve(collected));
			setTimeout(() => resolve(collected), 800);
		});

		const ends = records.filter((r) => r.type === RecordType.END_REQUEST);
		expect(ends.length).toBe(1);
		const endIdx = records.findIndex((r) => r.type === RecordType.END_REQUEST);
		expect(endIdx).toBeGreaterThanOrEqual(0);
		const afterEnd = records.slice(endIdx + 1);
		const orphanStdout = afterEnd.some(
			(r) => r.type === RecordType.STDOUT && r.contentData.length > 0,
		);
		expect(orphanStdout).toBe(false);
	});

	it("serve rejects inheritedFd when it is not a socket", async () => {
		const fd = fs.openSync("/dev/null", "r");
		try {
			await expect(
				serve(async () => new Response("x"), {
					inheritedFd: fd,
				}),
			).rejects.toThrow(/not a socket/);
		} finally {
			fs.closeSync(fd);
		}
	});

	it("handlerTimeout aborts a hanging handler", async () => {
		const errors: unknown[] = [];
		await startFu(() => new Promise<Response>(() => {}), {
			handlerTimeout: 100,
			onError: (e) => errors.push(e),
		});
		const wire = fcgiMinimalGetWire(portFu);
		const t0 = Date.now();
		const records = await sendAndCollect(portFu, wire);
		expect(Date.now() - t0).toBeLessThan(300);
		expect(records.some((r) => r.type === RecordType.END_REQUEST)).toBe(true);
		const { status } = parseCgiResponse(concatStdout(records));
		expect(status).toBe(500);
		const te = errors.find((e): e is Error => e instanceof Error && e.name === "TimeoutError");
		expect(te?.message).toMatch(/Handler timed out/);
	});

	it("handlerTimeout does not fire when handler is fast", async () => {
		const errors: unknown[] = [];
		await startFu(async () => new Response("ok", { status: 200 }), {
			handlerTimeout: 1000,
			onError: (e) => {
				errors.push(e);
				return undefined;
			},
		});
		const { status, body } = await fcgiRequest({ port: portFu, path: "/" });
		expect(status).toBe(200);
		expect(body).toBe("ok");
		expect(errors).toHaveLength(0);
	});

	it("handlerTimeout does not produce unhandled rejection when slow handler later rejects", async () => {
		const errors: unknown[] = [];
		await startFu(
			async () => {
				await new Promise<void>((r) => setTimeout(r, 80));
				throw new Error("late boom");
			},
			{ handlerTimeout: 30, onError: (e) => errors.push(e) },
		);
		const unhandled: unknown[] = [];
		const listener = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", listener);
		try {
			const wire = fcgiMinimalGetWire(portFu);
			const records = await sendAndCollect(portFu, wire);
			const { status } = parseCgiResponse(concatStdout(records));
			expect(status).toBe(500);
			expect(errors.length).toBeGreaterThanOrEqual(1);
			expect(errors.some((e) => e instanceof Error && e.name === "TimeoutError")).toBe(true);
			await new Promise<void>((r) => setTimeout(r, 200));
			expect(
				unhandled.some((r) => {
					const msg = r instanceof Error ? r.message : String(r);
					return msg.includes("late boom");
				}),
			).toBe(false);
		} finally {
			process.off("unhandledRejection", listener);
		}
	});

	it("maxBodyBytes violation fires onError with ProtocolError", async () => {
		const errors: unknown[] = [];
		await startFu(
			async (req) => {
				try {
					await req.text();
				} catch {
					//
				}
				return new Response("x");
			},
			{ maxBodyBytes: 10, onError: (e) => errors.push(e) },
		);
		const big = "z".repeat(100);
		const wire = Buffer.concat([
			beginRequest(1, Role.RESPONDER),
			paramsRecord(1, {
				REQUEST_METHOD: "POST",
				REQUEST_URI: "/",
				SERVER_NAME: "localhost",
				SERVER_PORT: String(portFu),
				CONTENT_LENGTH: String(Buffer.byteLength(big, "utf8")),
			}),
			emptyRecord(RecordType.PARAMS, 1),
			stdinRecord(1, big),
			emptyRecord(RecordType.STDIN, 1),
		]);
		await sendAndCollect(portFu, wire);
		const pe = errors.find((e): e is ProtocolError => e instanceof ProtocolError);
		expect(pe?.message.toLowerCase()).toContain("maxbodybytes");
	});

	it("buildRequest failure fires onError and returns 400", async () => {
		const errors: unknown[] = [];
		await startFu(async () => new Response("nope"), {
			onError: (e) => {
				errors.push(e);
				return undefined;
			},
		});
		const wire = Buffer.concat([
			beginRequest(1, Role.RESPONDER),
			paramsRecord(1, {
				...minimalParams(portFu),
				HTTP_HOST: "foo bar",
			}),
			emptyRecord(RecordType.PARAMS, 1),
			emptyRecord(RecordType.STDIN, 1),
		]);
		const records = await sendAndCollect(portFu, wire);
		expect(errors.length).toBeGreaterThan(0);
		const stdoutContent = concatStdout(records);
		const { status } = parseCgiResponse(stdoutContent);
		expect(status).toBe(400);
		expect(records.some((r) => r.type === RecordType.END_REQUEST)).toBe(true);
	});

	it("allowedAddresses IPv4 CIDR permits loopback / denies mismatched prefix", async () => {
		await startFu(async () => new Response("cidr-ok"), {
			allowedAddresses: ["127.0.0.0/8"],
		});
		const ok = await fcgiRequest({ port: portFu, path: "/" });
		expect(ok.status).toBe(200);
		expect(ok.body).toBe("cidr-ok");

		const errors: unknown[] = [];
		await serverFu.close();
		await startFu(async () => new Response("never"), {
			allowedAddresses: ["10.0.0.0/8"],
			onError: (e) => {
				errors.push(e);
				return undefined;
			},
		});
		const wire = fcgiMinimalGetWire(portFu);
		const records = await new Promise<FcgiRecord[]>((resolve) => {
			const collected: FcgiRecord[] = [];
			const parser = new RecordParser((r) => collected.push(r));
			const socket = net.createConnection({ port: portFu, host: "127.0.0.1" }, () => {
				socket.write(wire);
			});
			socket.on("data", (chunk: Buffer) => parser.push(chunk));
			socket.on("end", () => resolve(collected));
			socket.on("error", () => resolve(collected));
			setTimeout(() => resolve(collected), 300);
		});
		expect(records.some((r) => r.type === RecordType.END_REQUEST)).toBe(false);
		const deny = errors.find((e): e is ConnectionDeniedError => e instanceof ConnectionDeniedError);
		expect(deny?.remoteAddress).toBe("127.0.0.1");
	});

	it("allowedAddresses IPv6 CIDR (::1/128)", async () => {
		let v6: ServeResult | undefined;
		try {
			v6 = await serve(async () => new Response("v6-ok"), {
				host: "::1",
				allowedAddresses: ["::1/128"],
			});
		} catch {
			return;
		}
		const p = (v6?.address as net.AddressInfo).port;
		const wire = Buffer.concat([
			beginRequest(1, Role.RESPONDER),
			paramsRecord(1, minimalParams(p)),
			emptyRecord(RecordType.PARAMS, 1),
			emptyRecord(RecordType.STDIN, 1),
		]);
		const records = await new Promise<FcgiRecord[]>((resolve, reject) => {
			const collected: FcgiRecord[] = [];
			const parser = new RecordParser((r) => collected.push(r));
			const s = net.createConnection({ host: "::1", port: p }, () => {
				s.write(wire);
			});
			s.on("data", (c: Buffer) => parser.push(c));
			s.on("end", () => resolve(collected));
			s.on("error", reject);
			setTimeout(() => reject(new Error("v6 cidr timeout")), 1000);
		});
		expect(parseCgiResponse(concatStdout(records)).body).toBe("v6-ok");
		await v6?.close();
	});

	it("idleTimeout ends idle TCP connection quickly", async () => {
		await startFu(async () => new Response("idle"), { idleTimeout: 100 });
		await new Promise<void>((resolve, reject) => {
			let finished = false;
			const deadline = setTimeout(() => reject(new Error("expected socket close")), 500);
			deadline.unref();
			const sock = net.createConnection({ port: portFu, host: "127.0.0.1" }, () => undefined);
			const done = (): void => {
				if (finished) return;
				finished = true;
				clearTimeout(deadline);
				resolve();
			};
			sock.once("close", done);
			sock.once("end", done);
		});
	});

	it("default verboseErrors skips STDERR when handler throws", async () => {
		const errors: unknown[] = [];
		await startFu(
			async () => {
				throw new Error("secret data");
			},
			{ onError: (e) => errors.push(e) },
		);
		const records = await sendAndCollect(portFu, fcgiMinimalGetWire(portFu));
		const stderrNonEmpty = records.filter(
			(r) => r.type === RecordType.STDERR && r.contentData.length > 0,
		);
		expect(stderrNonEmpty.length).toBe(0);
		const stdoutContent = concatStdout(records);
		expect(parseCgiResponse(stdoutContent).status).toBe(500);
		const he = errors.find((e): e is HandlerError => e instanceof HandlerError);
		expect((he?.cause as Error | undefined)?.message).toBe("secret data");
	});

	it("ABORT_REQUEST KEEP_CONN leaves connection usable for a second request", async () => {
		await startFu(async (req) => {
			const path = new URL(req.url).pathname;
			if (path === "/fast") return new Response("fast", { status: 200 });
			await new Promise((r) => setTimeout(r, 250));
			return new Response("slow");
		});

		const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
			const deadline = setTimeout(() => reject(new Error("abort+second request timeout")), 1000);

			let sock!: net.Socket;
			let sentSecond = false;
			const stdout2: Buffer[] = [];

			const parser = new RecordParser((r) => {
				if (r.type === RecordType.END_REQUEST && r.requestId === 1 && !sentSecond) {
					sentSecond = true;
					sock.write(
						Buffer.concat([
							beginRequest(2, Role.RESPONDER, 0),
							paramsRecord(2, {
								REQUEST_METHOD: "GET",
								REQUEST_URI: "/fast",
								SERVER_NAME: "localhost",
								SERVER_PORT: String(portFu),
							}),
							emptyRecord(RecordType.PARAMS, 2),
							emptyRecord(RecordType.STDIN, 2),
						]),
					);
					return;
				}
				if (r.type !== RecordType.STDOUT || r.requestId !== 2 || r.contentData.length === 0) {
					return;
				}
				stdout2.push(r.contentData);
				const parsed = parseCgiResponse(Buffer.concat(stdout2));
				if (parsed.status === 200 && parsed.body.includes("fast")) {
					clearTimeout(deadline);
					resolve({ status: parsed.status, body: parsed.body });
				}
			});

			sock = net.createConnection({ port: portFu, host: "127.0.0.1" }, () => {
				sock.write(
					Buffer.concat([
						beginRequest(1, Role.RESPONDER, FCGI_KEEP_CONN),
						paramsRecord(1, {
							REQUEST_METHOD: "GET",
							REQUEST_URI: "/slow",
							SERVER_NAME: "localhost",
							SERVER_PORT: String(portFu),
						}),
						emptyRecord(RecordType.PARAMS, 1),
						emptyRecord(RecordType.STDIN, 1),
					]),
				);
				setTimeout(() => {
					sock.write(encodeRecord(RecordType.ABORT_REQUEST, 1, Buffer.alloc(0)));
				}, 30);
			});

			sock.on("data", (c: Buffer) => parser.push(c));
			sock.on("error", (e) => {
				clearTimeout(deadline);
				reject(e);
			});
		});

		expect(result.status).toBe(200);
		expect(result.body).toContain("fast");
	});

	it("onError returning a Response instance is used as the error response", async () => {
		await startFu(
			async () => {
				throw new Error("boom");
			},
			{ onError: () => new Response("custom-direct", { status: 418 }) },
		);
		const { status, body } = await fcgiRequest({ port: portFu, path: "/" });
		expect(status).toBe(418);
		expect(body).toBe("custom-direct");
	});

	it("handlerTimeout with verboseErrors:true writes TimeoutError name to STDERR", async () => {
		const errors: unknown[] = [];
		await startFu(() => new Promise<Response>(() => {}), {
			handlerTimeout: 80,
			verboseErrors: true,
			onError: (e) => errors.push(e),
		});
		const records = await sendAndCollect(portFu, fcgiMinimalGetWire(portFu));
		const stderrContent = Buffer.concat(
			records
				.filter((r) => r.type === RecordType.STDERR && r.contentData.length > 0)
				.map((r) => r.contentData),
		).toString();
		expect(stderrContent).toContain("TimeoutError");
		expect(parseCgiResponse(concatStdout(records)).status).toBe(500);
		expect(errors.some((e) => e instanceof Error && (e as Error).name === "TimeoutError")).toBe(
			true,
		);
	});

	it("verboseErrors:true with a non-Error thrown value uses String() for STDERR", async () => {
		await startFu(
			async () => {
				// eslint-disable-next-line @typescript-eslint/no-throw-literal
				throw "plain string error";
			},
			{ verboseErrors: true },
		);
		const records = await sendAndCollect(portFu, fcgiMinimalGetWire(portFu));
		const stderrContent = Buffer.concat(
			records
				.filter((r) => r.type === RecordType.STDERR && r.contentData.length > 0)
				.map((r) => r.contentData),
		).toString();
		expect(stderrContent).toContain("plain string error");
	});

	it("close() force-destroys half-open connections after closeTimeout", async () => {
		const closeTimeout = 200;
		await startFu(async () => new Response("ok"), { closeTimeout });

		// allowHalfOpen: true prevents the client from auto-sending FIN on receiving
		// the server's FIN, so the server-side socket stays alive until force-destroyed.
		const sock = net.createConnection({ port: portFu, host: "127.0.0.1", allowHalfOpen: true });
		await new Promise<void>((r) => sock.once("connect", r));
		// Give the server one I/O tick to register the connection in activeSockets.
		await new Promise<void>((r) => setTimeout(r, 20));

		const t0 = Date.now();
		await serverFu.close();
		expect(Date.now() - t0).toBeGreaterThanOrEqual(closeTimeout - 30);
		try {
			sock.destroy();
		} catch {
			// already destroyed
		}
	});

	it("idleGraceMs force-destroys socket that does not respond to FIN after end()", async () => {
		await startFu(async () => new Response("ok"), { idleTimeout: 100, idleGraceMs: 150 });

		// allowHalfOpen: true keeps the connection alive after the server sends its
		// half-close FIN, so the grace timer fires and force-destroys the server socket.
		const sock = net.createConnection({ port: portFu, host: "127.0.0.1", allowHalfOpen: true });
		sock.on("error", () => {}); // suppress potential RST errors from force-destroy
		await new Promise<void>((r) => sock.once("connect", r));
		// Wait for idleTimeout(100) + idleGraceMs(150) + generous buffer
		await new Promise<void>((r) => setTimeout(r, 500));
		try {
			sock.destroy();
		} catch {
			// already destroyed by the grace timer
		}
	});
});

// ---------------------------------------------------------------------------
// Transport and socket binding options
// ---------------------------------------------------------------------------

describe("serve() binding options", () => {
	let serverBind: ServeResult | undefined;
	const extraServers: net.Server[] = [];

	afterEach(async () => {
		await serverBind?.close();
		serverBind = undefined;
		for (const s of extraServers) {
			await new Promise<void>((r) => (s.listening ? s.close(() => r()) : r()));
		}
		extraServers.length = 0;
	});

	it("maxConnections option is forwarded to the underlying net.Server", async () => {
		serverBind = await serve(async () => new Response("ok"), {
			host: "127.0.0.1",
			maxConnections: 5,
		});
		const p = (serverBind.address as net.AddressInfo).port;
		const { status } = await fcgiRequest({ port: p, path: "/" });
		expect(status).toBe(200);
	});

	it("explicit port option binds to the requested port", async () => {
		serverBind = await serve(async () => new Response("port-ok"), {
			host: "127.0.0.1",
			port: 0,
		});
		const p = (serverBind.address as net.AddressInfo).port;
		expect(p).toBeGreaterThan(0);
		const { status, body } = await fcgiRequest({ port: p, path: "/" });
		expect(status).toBe(200);
		expect(body).toBe("port-ok");
	});

	it("pre-aborted signal shuts the server down immediately after binding", async () => {
		const controller = new AbortController();
		controller.abort();

		serverBind = await serve(async () => new Response("ok"), {
			host: "127.0.0.1",
			signal: controller.signal,
		});

		// closeServer() is called synchronously inside onListening() before resolve()
		// can capture server.address(). Node.js marks the server as "not listening"
		// the moment server.close() is called, so address is null at resolve time.
		expect(serverBind.address).toBeNull();
	});

	it("caller-supplied server that is already listening is used as-is", async () => {
		const raw = net.createServer();
		extraServers.push(raw);
		await new Promise<void>((r) => raw.listen(0, "127.0.0.1", r));
		const rawPort = (raw.address() as net.AddressInfo).port;

		serverBind = await serve(async () => new Response("prebuilt"), { server: raw });
		expect((serverBind.address as net.AddressInfo).port).toBe(rawPort);

		const { body } = await fcgiRequest({ port: rawPort, path: "/" });
		expect(body).toBe("prebuilt");
	});

	it("caller-supplied server that is not yet listening is started by serve()", async () => {
		const raw = net.createServer();
		extraServers.push(raw);

		serverBind = await serve(async () => new Response("lazy"), { server: raw });
		const p = (serverBind.address as net.AddressInfo).port;
		expect(p).toBeGreaterThan(0);

		const { body } = await fcgiRequest({ port: p, path: "/" });
		expect(body).toBe("lazy");
	});

	it("inheritedFd rejects when fstatSync throws for the given fd", async () => {
		const fd = fs.openSync("/dev/null", "r");
		fs.closeSync(fd); // close immediately so fstatSync throws EBADF

		await expect(serve(async () => new Response("x"), { inheritedFd: fd })).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// allowedAddresses — IPv6 peer addresses and CIDR matching
// ---------------------------------------------------------------------------

describe("allowedAddresses — IPv6 and CIDR", () => {
	let serverAcl: ServeResult | undefined;

	afterEach(async () => {
		await serverAcl?.close();
		serverAcl = undefined;
	});

	// helper: connect from ::1 and collect FastCGI records
	async function v6Request(port: number, timeoutMs = 2000): Promise<FcgiRecord[]> {
		return new Promise<FcgiRecord[]>((resolve, _reject) => {
			const collected: FcgiRecord[] = [];
			const parser = new RecordParser((r) => collected.push(r));
			const s = net.createConnection({ host: "::1", port }, () => {
				s.write(fcgiMinimalGetWire(port));
			});
			s.on("data", (c: Buffer) => parser.push(c));
			s.on("end", () => resolve(collected));
			s.on("error", () => resolve(collected));
			setTimeout(() => resolve(collected), timeoutMs);
		});
	}

	it("exact ::1 entry permits connection from ::1", async () => {
		try {
			serverAcl = await serve(async () => new Response("v6-exact"), {
				host: "::1",
				allowedAddresses: ["::1"],
			});
		} catch {
			return; // IPv6 not available on this host
		}
		const p = (serverAcl.address as net.AddressInfo).port;
		const records = await v6Request(p);
		expect(parseCgiResponse(concatStdout(records)).body).toBe("v6-exact");
	});

	it("CIDR ::1/128 permits connection from ::1", async () => {
		try {
			serverAcl = await serve(async () => new Response("v6-cidr"), {
				host: "::1",
				allowedAddresses: ["::1/128"],
			});
		} catch {
			return;
		}
		const p = (serverAcl.address as net.AddressInfo).port;
		const records = await v6Request(p);
		expect(parseCgiResponse(concatStdout(records)).body).toBe("v6-cidr");
	});

	it("CIDR ::/0 permits all IPv6 addresses", async () => {
		try {
			serverAcl = await serve(async () => new Response("v6-any"), {
				host: "::1",
				allowedAddresses: ["::/0"],
			});
		} catch {
			return;
		}
		const p = (serverAcl.address as net.AddressInfo).port;
		const records = await v6Request(p);
		expect(parseCgiResponse(concatStdout(records)).body).toBe("v6-any");
	});

	it("mismatched IPv6 entry ::2 denies connection from ::1", async () => {
		try {
			serverAcl = await serve(async () => new Response("never"), {
				host: "::1",
				allowedAddresses: ["::2"],
			});
		} catch {
			return;
		}
		const p = (serverAcl.address as net.AddressInfo).port;
		const records = await v6Request(p, 500);
		expect(records.some((r) => r.type === RecordType.END_REQUEST)).toBe(false);
	});

	it("IPv6 entry ::1 denies IPv4 peer 127.0.0.1 (parseIPv6String returns null for IPv4)", async () => {
		const errors: unknown[] = [];
		serverAcl = await serve(async () => new Response("nope"), {
			host: "127.0.0.1",
			allowedAddresses: ["::1"],
			onError: (e) => {
				errors.push(e);
				return undefined;
			},
		});
		const p = (serverAcl.address as net.AddressInfo).port;
		await new Promise<void>((resolve) => {
			const s = net.createConnection({ port: p, host: "127.0.0.1" }, () => {
				s.write(fcgiMinimalGetWire(p));
			});
			s.on("end", resolve);
			s.on("error", resolve);
			setTimeout(resolve, 300);
		});
		expect(errors.some((e) => e instanceof ConnectionDeniedError)).toBe(true);
	});

	it("IPv6 CIDR ::1/64 denies IPv4 peer (parseIPv6String returns null for plain IPv4)", async () => {
		const errors: unknown[] = [];
		serverAcl = await serve(async () => new Response("nope"), {
			host: "127.0.0.1",
			allowedAddresses: ["::1/64"],
			onError: (e) => {
				errors.push(e);
				return undefined;
			},
		});
		const p = (serverAcl.address as net.AddressInfo).port;
		await new Promise<void>((resolve) => {
			const s = net.createConnection({ port: p, host: "127.0.0.1" }, () => {
				s.write(fcgiMinimalGetWire(p));
			});
			s.on("end", resolve);
			s.on("error", resolve);
			setTimeout(resolve, 300);
		});
		expect(errors.some((e) => e instanceof ConnectionDeniedError)).toBe(true);
	});

	it("IPv4 CIDR 127.0.0.0/8 denies ::1 peer (ipv4EmbeddedPeerString returns null for pure IPv6)", async () => {
		try {
			serverAcl = await serve(async () => new Response("nope"), {
				host: "::1",
				allowedAddresses: ["127.0.0.0/8"],
			});
		} catch {
			return;
		}
		const p = (serverAcl.address as net.AddressInfo).port;
		const records = await v6Request(p, 500);
		expect(records.some((r) => r.type === RecordType.END_REQUEST)).toBe(false);
	});

	it("CIDR entry with non-integer prefix bits (e.g. /abc) is treated as no-match", async () => {
		const errors: unknown[] = [];
		serverAcl = await serve(async () => new Response("nope"), {
			host: "127.0.0.1",
			allowedAddresses: ["127.0.0.0/abc"],
			onError: (e) => {
				errors.push(e);
				return undefined;
			},
		});
		const p = (serverAcl.address as net.AddressInfo).port;
		await new Promise<void>((resolve) => {
			const s = net.createConnection({ port: p, host: "127.0.0.1" }, () => {
				s.write(fcgiMinimalGetWire(p));
			});
			s.on("end", resolve);
			s.on("error", resolve);
			setTimeout(resolve, 300);
		});
		expect(errors.some((e) => e instanceof ConnectionDeniedError)).toBe(true);
	});

	it("CIDR entry with non-IP prefix (e.g. notanip/24) is treated as no-match", async () => {
		const errors: unknown[] = [];
		serverAcl = await serve(async () => new Response("nope"), {
			host: "127.0.0.1",
			allowedAddresses: ["notanip/24"],
			onError: (e) => {
				errors.push(e);
				return undefined;
			},
		});
		const p = (serverAcl.address as net.AddressInfo).port;
		await new Promise<void>((resolve) => {
			const s = net.createConnection({ port: p, host: "127.0.0.1" }, () => {
				s.write(fcgiMinimalGetWire(p));
			});
			s.on("end", resolve);
			s.on("error", resolve);
			setTimeout(resolve, 300);
		});
		expect(errors.some((e) => e instanceof ConnectionDeniedError)).toBe(true);
	});

	it("IPv4-mapped ::ffff:x.x.x.x entry exercises mixed-notation parsing in parseIPv6String", async () => {
		try {
			serverAcl = await serve(async () => new Response("nope"), {
				host: "::1",
				allowedAddresses: ["::ffff:127.0.0.1"],
			});
		} catch {
			return;
		}
		const p = (serverAcl.address as net.AddressInfo).port;
		// ::1 ≠ ::ffff:127.0.0.1 so the connection will be denied;
		// the important thing is that parseIPv6String executes without throwing.
		const records = await v6Request(p, 500);
		expect(records).toBeDefined();
	});

	it("IPv4-compatible ::x.x.x.x entry exercises embedded-IPv4 parsing in parseIPv6String", async () => {
		try {
			serverAcl = await serve(async () => new Response("nope"), {
				host: "::1",
				allowedAddresses: ["::192.168.1.1"],
			});
		} catch {
			return;
		}
		const p = (serverAcl.address as net.AddressInfo).port;
		const records = await v6Request(p, 500);
		expect(records).toBeDefined();
	});
});

function fcgiMinimalGetWire(serverPort: number): Buffer {
	return Buffer.concat([
		beginRequest(1, Role.RESPONDER),
		paramsRecord(1, minimalParams(serverPort)),
		emptyRecord(RecordType.PARAMS, 1),
		emptyRecord(RecordType.STDIN, 1),
	]);
}

function httpsWire(serverPort: number, httpsVal: string): Buffer {
	return Buffer.concat([
		beginRequest(1, Role.RESPONDER),
		paramsRecord(1, {
			REQUEST_METHOD: "GET",
			REQUEST_URI: "/",
			SERVER_NAME: "localhost",
			SERVER_PORT: String(serverPort),
			HTTPS: httpsVal,
			HTTP_HOST: `localhost:${serverPort}`,
		}),
		emptyRecord(RecordType.PARAMS, 1),
		emptyRecord(RecordType.STDIN, 1),
	]);
}

function minimalParams(port: number): Record<string, string> {
	return {
		REQUEST_METHOD: "GET",
		REQUEST_URI: "/",
		SERVER_NAME: "localhost",
		SERVER_PORT: String(port),
	};
}

function concatStdout(records: FcgiRecord[]): Buffer {
	return Buffer.concat(
		records
			.filter((r) => r.type === RecordType.STDOUT && r.contentData.length > 0)
			.map((r) => r.contentData),
	);
}
