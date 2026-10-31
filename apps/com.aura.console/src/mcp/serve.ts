/**
 * MCP over HTTP for the Console app — the same plumbing as the Terminal's,
 * Notepad's and Settings' `src/mcp/serve.ts`: a new MCP is a `build()`
 * function plus a three-line route under `src/pages/mcp/<name>.ts`, and a
 * `provides` entry in the manifest so the Interface Registry advertises it.
 *
 *   • STATELESS (`sessionIdGenerator: undefined`): every request builds a
 *     fresh Server + transport and throws both away. An Astro dev route has
 *     nowhere durable to keep a session table (the app restarts whenever its
 *     files change), and the tools are plain request/response.
 *   • JSON RESPONSES (`enableJsonResponse: true`), not SSE: one inspectable
 *     body per POST, no stream to keep alive through the shell proxy.
 *
 * GET is answered with 405 here, not by the transport: a stateless server has
 * no notifications to stream, and a stream the per-request teardown closes at
 * once makes clients reconnect forever. 405 is what clients take as final.
 */
import type { APIRoute } from 'astro';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

/** Export the result as `ALL` so DELETE reaches the transport too. */
export function createMcpRoute(build: () => Server): APIRoute {
  return async ({ request }) => {
    if (request.method === 'GET') return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } });
    const server = build();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      void server.close().catch(() => { /* already closed */ });
    }
  };
}
