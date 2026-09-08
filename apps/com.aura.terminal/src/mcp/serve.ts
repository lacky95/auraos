/**
 * MCP over HTTP for the Terminal app — the plumbing every MCP this app serves
 * shares. Same shape as the Notepad's and Settings' `src/mcp/serve.ts`: a new MCP
 * is a `build()` function plus a three-line route under `src/pages/mcp/<name>.ts`,
 * and a `provides` entry in the manifest so the Interface Registry advertises it.
 *
 * Two deliberate choices:
 *
 *   • STATELESS. `sessionIdGenerator: undefined` disables MCP sessions, so
 *     every request builds a fresh Server + transport and throws both away
 *     afterwards. An Astro dev route has nowhere durable to keep a session
 *     table (the app restarts whenever its files change), and the tools here
 *     are plain request/response, so sessions would buy nothing and cost a
 *     class of "session not found" errors after every restart.
 *
 *   • JSON RESPONSES, not SSE. `enableJsonResponse: true` answers each POST
 *     with a single JSON body instead of opening an event stream. A JSON
 *     reply is inspectable with curl and has no connection to keep alive
 *     through the shell proxy. Stateless servers cannot push notifications
 *     anyway, so nothing is lost.
 *
 * The long-lived things — the shells — are NOT tied to this per-request
 * lifetime; they live in tmux, outside this process entirely.
 *
 * The transport implements the Streamable HTTP spec on Web-standard
 * Request/Response, which is exactly what an Astro API route gets and returns.
 */
import type { APIRoute } from 'astro';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

/**
 * Turn a low-level `Server` factory into an Astro route. Export the result as
 * `ALL` so GET and DELETE reach the transport too — it answers each method
 * per spec (GET opens a notification stream the per-request teardown ends at
 * once; DELETE is a 200 no-op).
 */
export function createMcpRoute(build: () => Server): APIRoute {
  return async ({ request }) => {
    const server = build();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      // Per-request lifetime: the JSON body is complete by the time
      // handleRequest resolves, so nothing is cut off.
      void server.close().catch(() => { /* already closed */ });
    }
  };
}
