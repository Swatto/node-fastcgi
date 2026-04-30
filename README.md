# node-fastcgi

A FastCGI Responder library for Node.js with a **Web-standard `Request`/`Response` API** with zero dependencies.

The handler signature is identical to the [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API), so switching between a regular HTTP server and FastCGI is a one-line change.

## Installation

```bash
pnpm add @swatto/node-fastcgi
# or
npm install @swatto/node-fastcgi
```

Requires Node.js ≥ 20.

## Quick start

```ts
import { serve } from "@swatto/node-fastcgi";

const handler = async (req: Request): Promise<Response> => {
  return new Response(`Hello from ${req.url}`, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
};

// Bind a TCP port
const server = await serve(handler, { port: 9000 });
console.log("Listening on", server.address);

// Graceful shutdown
process.on("SIGTERM", () => server.close());
```

## Swapping from Node's built-in `http`

The handler is the same — only the `serve` call changes:

```ts
// HTTP server (built-in Node.js)
import { createServer } from "node:http";

createServer((nodeReq, nodeRes) => {
  // ...old Node.js http style, not compatible
}).listen(3000);

// ↓ With @swatto/node-fastcgi — same Web-standard handler, zero changes to business logic

import { serve } from "@swatto/node-fastcgi";

const handler = async (req: Request): Promise<Response> => {
  // same code you'd write for Deno / Bun / Cloudflare Workers / etc.
  const body = await req.json();
  return Response.json({ received: body });
};

await serve(handler, { socketPath: "/run/myapp.sock" });
```

## Why FastCGI?

When you run Node.js behind a web server like nginx or Caddy, the default setup is a **reverse proxy**: the web server accepts HTTP connections and forwards them to your Node.js process over a second TCP connection on localhost. This works, but it means every request travels through two full HTTP stacks — one in the web server and one in Node.js.

**FastCGI** is a lighter-weight alternative. Instead of speaking HTTP twice, the web server and your application process communicate over a simple binary framing protocol on a Unix socket or TCP connection. The web server handles TLS termination, static files, compression, and rate limiting; your application only ever sees already-decoded requests and sends back responses. No second HTTP parse, no chunked-transfer overhead, no keep-alive negotiation.

### Practical advantages

**Performance** — A Unix socket FastCGI connection avoids the TCP handshake and the HTTP framing overhead on every request. The binary FastCGI protocol is also more compact than HTTP/1.1 headers, which matters at high request rates.

**Process model** — The web server spawns (or connects to) your Node.js process directly. There is no intermediate proxy daemon to manage, and the web server can apply its own load balancing and health-check logic directly to FastCGI backends.

**Battle-tested operational story** — PHP has been deployed this way (via php-fpm) for decades. nginx and Caddy have mature, well-documented FastCGI support with fine-grained control over timeouts, buffering, and caching that isn't always available in their `proxy_pass` directives.

**TLS handled once** — Because the web server terminates TLS before the FastCGI call, your Node.js process never touches certificates or cipher negotiation. This simplifies certificate rotation and reduces attack surface.

### When to prefer a plain reverse proxy instead

FastCGI is a good fit for **long-running Node.js processes** that stay resident and handle many requests. If you need WebSocket support, HTTP/2 server push, or complex streaming, a standard reverse proxy (`proxy_pass` / `reverse_proxy`) is more straightforward because it keeps a full HTTP connection end-to-end.

## API

### `serve(handler, options?)`

```ts
type Handler = (request: Request) => Response | Promise<Response>;

interface ServeOptions {
  port?: number;               // TCP port (default: random ephemeral)
  host?: string;               // TCP host (default: "127.0.0.1")
  socketPath?: string;         // Unix socket path
  socketMode?: number;        // File-mode for the Unix socket file (e.g. `0o660`)
  server?: net.Server;        // Bring your own net.Server
  inheritedFd?: number;       // fd from web server (FCGI_LISTENSOCK_FILENO = 0)
  allowedAddresses?: string[]; // FCGI_WEB_SERVER_ADDRS peer-IP allowlist (TCP only)
  signal?: AbortSignal;       // Abort to trigger graceful shutdown
  idleTimeout?: number;       // Milliseconds of inactivity before connection close (default: no timeout; recommended 60_000)
  idleGraceMs?: number;       // After `idleTimeout` fires `socket.end()`, milliseconds to wait before forcing `socket.destroy()` (default: 5000)
  maxConnections?: number;    // Max concurrent connections (default: unlimited)
  maxRequestsPerConnection?: number; // Max requests on a keep-alive connection before close (default: unlimited)
  maxBodyBytes?: number;      // Max FCGI_STDIN bytes per request; exceeding aborts the request (default: unlimited)
  maxParamsBytes?: number;    // Max total FCGI_PARAMS bytes per request (default: 65536)
  maxParamsCount?: number;    // Max name/value pairs per request (default: 1000)
  maxBufferedBytes?: number;  // Max unread bytes the per-connection record parser will buffer before destroying the connection (anti-slowloris, default: 8 MiB)
  closeTimeout?: number;      // Max milliseconds `close()` waits for active connections to drain before force-destroying them (default: 5000)
  handlerTimeout?: number;    // Max milliseconds a single handler may run before being aborted (default: no timeout)
  verboseErrors?: boolean;    // When true, forward error messages to FastCGI STDERR (default: false)
  onError?: (
    err: unknown,
    req?: Request,
  ) => Response | { response?: Response; appStatus?: number } | undefined;
}

interface ServeResult {
  close(): Promise<void>;
  address: net.AddressInfo | string | null;
}

function serve(handler: Handler, options?: ServeOptions): Promise<ServeResult>;
```

`ServeOptions` covers transport (`port`, `host`, `socketPath`, `socketMode`, `server`, `inheritedFd`), shutdown (`signal`, `closeTimeout`), connection lifecycle (`idleTimeout`, `idleGraceMs`, `maxConnections`, `maxRequestsPerConnection`), request limits (`handlerTimeout`, `maxBodyBytes`, `maxParamsBytes`, `maxParamsCount`, `maxBufferedBytes`), peer filtering (`allowedAddresses`), diagnostics (`verboseErrors`, `onError`), and hardening defaults as noted in the comments above.

`allowedAddresses` entries may be single IPs or CIDR prefixes, for example `10.0.0.0/8`, `192.168.1.0/24`, or `::1/128` alongside literal addresses like `127.0.0.1`.

**Transport resolution order** (first match wins):

1. `options.server` — caller-supplied `net.Server`
2. `options.inheritedFd` — file descriptor inherited from the web server (spec §2.2)
3. `options.socketPath` — Unix socket
4. `options.port` / `options.host` — TCP

### Exported types

```ts
import type { Handler, ServeOptions, ServeResult } from "@swatto/node-fastcgi";
import { ProtocolError, HandlerError, ConnectionDeniedError } from "@swatto/node-fastcgi";
```

## Framework compatibility

`node-fastcgi` accepts any handler with the signature `(req: Request) => Response | Promise<Response>` — the same contract as the [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API). Any framework that exposes this style works as a drop-in.

### Hono

[Hono](https://hono.dev/)'s `app.fetch` matches the handler type exactly:

```ts
import { Hono } from "hono";
import { serve } from "@swatto/node-fastcgi";

const app = new Hono();
app.get("/hello", (c) => c.text("Hello!"));

await serve(app.fetch.bind(app), { socketPath: "/run/myapp.sock" });
```

### tRPC

Use [`fetchRequestHandler`](https://trpc.io/docs/server/adapters/fetch) from `@trpc/server/adapters/fetch`:

```ts
import { initTRPC } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { serve } from "@swatto/node-fastcgi";

const t = initTRPC.create();
const router = t.router({
  hello: t.procedure.query(() => ({ message: "Hello!" })),
});

await serve(
  (req) => fetchRequestHandler({ endpoint: "/trpc", req, router, createContext: () => ({}) }),
  { socketPath: "/run/myapp.sock" },
);
```

### h3 / Nitro

[h3](https://h3.unjs.io/) (the server engine behind [Nitro](https://nitro.build/) and Nuxt) exposes `app.fetch` directly:

```ts
import { createApp, createRouter, defineEventHandler } from "h3";
import { serve } from "@swatto/node-fastcgi";

const app = createApp();
const router = createRouter();
router.get("/hello", defineEventHandler(() => ({ message: "Hello!" })));
app.use(router);

await serve(app.fetch.bind(app), { socketPath: "/run/myapp.sock" });
```

### Express and other Node.js-style frameworks

Express (and any framework built on Node.js `IncomingMessage`/`ServerResponse`) is **not directly compatible** — its handler signature is `(req, res) => void`, not `(req: Request) => Response`. There is no reliable zero-overhead adapter between the two models.

The recommended migration path is to move routes to a fetch-native framework such as **Hono**, whose API is intentionally close to Express:

```ts
// Express                          // Hono equivalent
app.get("/users/:id", (req, res) => app.get("/users/:id", (c) =>
  res.json({ id: req.params.id }));   c.json({ id: c.req.param("id") }));
```

## Recipes

### Unix socket (recommended for nginx/Caddy on the same host)

```ts
await serve(handler, { socketPath: "/run/myapp/fastcgi.sock" });
```

### TCP (Docker, separate hosts)

```ts
await serve(handler, { port: 9000, host: "0.0.0.0" });
```

### Inherited fd (classic FastCGI spawn)

When a web server spawns your process, it passes the listening socket on fd 0:

```ts
await serve(handler, { inheritedFd: 0 }); // FCGI_LISTENSOCK_FILENO
```

### AbortSignal for graceful shutdown

```ts
const ac = new AbortController();
process.on("SIGTERM", () => ac.abort());
await serve(handler, { port: 9000, signal: ac.signal });
```

### Custom error handling

```ts
await serve(handler, {
  onError(err, req) {
    console.error("Handler error for", req?.url, err);
    return new Response("Something went wrong", { status: 500 });
  },
});
```

### Hardening recommendations

For production, consider:

- `handlerTimeout` — bound runaway handlers (e.g. `30_000`).
- `idleTimeout` — close stalled keep-alive connections (e.g. `60_000`).
- `maxConnections` and `maxRequestsPerConnection` — bound resource usage.
- `maxBodyBytes` — bound request body memory (e.g. `10 * 1024 * 1024`).
- `maxBufferedBytes` — defaults to 8 MiB; lower it (e.g. `1024 * 1024`) if you only ever expect small records and want a tighter slowloris cap.
- `socketMode: 0o660` and `allowedAddresses` — restrict who can talk to the FastCGI process.
- `verboseErrors: false` (default) — keep stack traces out of the web-server error log.

## nginx configuration

### Unix socket

```nginx
server {
    listen 80;
    server_name example.com;

    root /var/www/myapp/public;

    location / {
        try_files $uri @fastcgi;
    }

    location @fastcgi {
        include fastcgi_params;
        fastcgi_pass unix:/run/myapp/fastcgi.sock;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }
}
```

### TCP

```nginx
location @fastcgi {
    include fastcgi_params;
    fastcgi_pass 127.0.0.1:9000;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
}
```

## Caddy configuration

```caddy
example.com {
    root * /var/www/myapp/public
    file_server

    @missing not file
    handle @missing {
        reverse_proxy unix//run/myapp/fastcgi.sock {
            transport fastcgi
        }
    }
}
```

## Protocol compliance

Implements the [FastCGI specification v1.0](https://fast-cgi.github.io/spec) (Responder role):

| Feature | Status |
|---|---|
| Responder role (§6.2) | ✅ |
| FCGI_GET_VALUES / _RESULT (§4.1) | ✅ |
| FCGI_UNKNOWN_TYPE for unknown management records (§4.2) | ✅ |
| FCGI_ABORT_REQUEST → AbortSignal (§5.4) | ✅ |
| FCGI_KEEP_CONN — persistent connections (§5.1) | ✅ |
| FCGI_MPXS_CONNS=0 — sequential requests per connection (§4.1) | ✅ |
| FCGI_CANT_MPX_CONN rejection (§5.5) | ✅ |
| FCGI_UNKNOWN_ROLE rejection (§5.5) | ✅ |
| FCGI_WEB_SERVER_ADDRS peer-IP allowlist (§3.2) | ✅ |
| FCGI_LISTENSOCK_FILENO inherited fd (§2.2) | ✅ |
| Record padding (8-byte alignment, §3.3) | ✅ |
| Name/value pair 1/4-byte length encoding (§3.4) | ✅ |
| Authorizer / Filter roles | out of scope |
| Connection multiplexing (MPXS_CONNS=1) | out of scope |

## CGI variable → Request mapping

| CGI variable | Request field |
|---|---|
| `REQUEST_METHOD` | `method` |
| `HTTPS` + `HTTP_HOST` + `REQUEST_URI` | `url` |
| `HTTP_*` (e.g. `HTTP_ACCEPT`) | header `accept` |
| `CONTENT_TYPE` | header `content-type` |
| `CONTENT_LENGTH` | header `content-length` |
| `FCGI_STDIN` stream | `body` (ReadableStream) |

## Development

```bash
pnpm build          # compile with tsdown
pnpm test           # run tests with vitest
pnpm test:coverage  # coverage report
pnpm typecheck      # tsc --noEmit
pnpm check          # biome lint + format
```

## Stability

The public API for v1.x—the `serve()` entrypoint, handler type `(req: Request) => Response | Promise<Response>`, and the documented exports—is treated as stable: new `ServeOptions` fields may appear, but existing option names and semantics are not intentionally changed in minor or patch releases.

## License

[MIT](./LICENSE) © Gaël Gillard
