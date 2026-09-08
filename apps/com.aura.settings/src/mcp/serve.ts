/**
 * MCP over HTTP for the Settings app — the one piece of plumbing every MCP
 * this app serves shares. A new MCP is a `build()` function plus a three-line
 * route under `src/pages/mcp/<name>.ts`, and a `provides` entry in the
 * manifest so the Interface Registry advertises it.
 *
 * Two deliberate choices:
 *
 *   • STATELESS. Omitting `sessionIdGenerator` disables MCP sessions, so
 *     every request builds a fresh McpServer + transport and throws both away
 *     afterwards. An Astro dev route has nowhere durable to keep a session
 *     table (the app restarts whenever its files change), and the tools here
 *     are plain request/response, so sessions would buy nothing and cost a
 *     class of "session not found" errors after every restart.
 *
 *   • JSON RESPONSES, not SSE. `enableJsonResponse: true` answers each POST
 *     with a single JSON body instead of opening an event stream. The shell
 *     proxy can stream SSE fine, but a JSON reply is inspectable with curl and
 *     has no connection to keep alive through the proxy. Stateless servers
 *     cannot push notifications anyway, so nothing is lost.
 *
 * The transport implements the Streamable HTTP spec on Web-standard
 * Request/Response, which is exactly what an Astro API route gets and returns
 * — no Node http adapter in between.
 */
import type { APIRoute } from 'astro';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

/**
 * Turn an McpServer factory into an Astro route. Export the result as `ALL`
 * so GET and DELETE reach the transport too — it knows how to answer each
 * method per spec. DELETE (session teardown) is a 200 no-op. GET is the one
 * exception, answered 405 below — see the comment there.
 */
export function createMcpRoute(build: () => McpServer): APIRoute {
  return async ({ request }) => {
    // A stateless server has no notification stream to offer. Letting the
    // transport open one that the teardown below closes at once made clients
    // reconnect every second, forever; the spec's answer is 405.
    if (request.method === 'GET') return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } });
    const server = build();
    const transport = new WebStandardStreamableHTTPServerTransport({
      // No sessionIdGenerator → stateless mode (see header).
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      // Per-request lifetime: the JSON body is complete by the time
      // handleRequest resolves, so nothing is cut off. Close explicitly rather
      // than leaking a server whose transport nobody will ever call again.
      void server.close().catch(() => { /* already closed */ });
    }
  };
}
