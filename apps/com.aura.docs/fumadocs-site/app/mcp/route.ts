// /mcp — the Aura Docs MCP server (see lib/mcp.ts). Next's basePath already
// carries the shell's proxy prefix, so this lands on
// /api/proxy/com.aura.docs/mcp, the address the manifest advertises.
//
// GET is answered 405 rather than handed to the transport: a client opens GET
// to listen for server notifications, and a stateless server has none — same
// reasoning (and the same reconnect-storm it avoids) as the Notepad MCP route.
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildDocsServer } from '@/lib/mcp';

export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  const server = buildDocsServer();
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
}

export const POST = handle;
export const DELETE = handle;

export function GET(): Response {
  return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } });
}
