/**
 * FastCGI fixture app used by the E2E test suite.
 *
 * Imports the *built* library so the E2E run also validates the compiled dist.
 * Routes are intentionally minimal — just enough to exercise the key behaviours.
 */

import { serve } from "../../../dist/index.mjs";

/** @param {Request} req */
const handler = async (req) => {
	const url = new URL(req.url);
	const { pathname } = url;

	if (pathname === "/hello") {
		const name = url.searchParams.get("name") ?? "World";
		return new Response(`Hello, ${name}!`, {
			headers: { "content-type": "text/plain" },
		});
	}

	if (pathname === "/echo") {
		const body = await req.text();
		return new Response(body, {
			headers: {
				"content-type": req.headers.get("content-type") ?? "text/plain",
			},
		});
	}

	if (pathname === "/headers") {
		const value = req.headers.get("x-custom") ?? "(none)";
		return new Response(value, { headers: { "content-type": "text/plain" } });
	}

	if (pathname === "/json") {
		return Response.json({ path: pathname, method: req.method });
	}

	if (pathname === "/error") {
		throw new Error("intentional crash");
	}

	if (pathname.startsWith("/status/")) {
		const code = Number(pathname.slice(8));
		if (Number.isInteger(code) && code >= 100 && code < 600) {
			return new Response(String(code), { status: code });
		}
	}

	return new Response("Not Found", { status: 404 });
};

const port = Number(process.env.FCGI_PORT ?? 9000);
await serve(handler, { host: "0.0.0.0", port });
console.log(`FastCGI fixture app listening on :${port}`);
