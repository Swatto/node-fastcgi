/**
 * node-fastcgi
 *
 * A FastCGI Responder library for Node.js that uses the Web-standard
 * `Request` and `Response` API, making it trivial to swap between
 * FastCGI and a regular HTTP server.
 *
 * @example
 * ```ts
 * import { serve } from "@swatto/node-fastcgi";
 *
 * const handler = async (req: Request): Promise<Response> => {
 *   return new Response(`Hello from ${req.url}`, { status: 200 });
 * };
 *
 * // Bind a TCP port
 * const server = await serve(handler, { port: 9000 });
 *
 * // Or a Unix socket
 * const server2 = await serve(handler, { socketPath: "/tmp/app.sock" });
 *
 * // Graceful shutdown
 * await server.close();
 * ```
 */

export { ConnectionDeniedError, HandlerError, ProtocolError } from "./errors.js";
export type { Handler, ServeOptions, ServeResult } from "./serve.js";
export { serve } from "./serve.js";
