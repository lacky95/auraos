import { createMcpRoute } from '../../../mcp/serve';
import { buildShellServer } from '../../../mcp/shell';

// Under /api/ on purpose: the OS proxy exposes a SERVICE's /api/* surface
// only — a service has no UI, so `/mcp/shell` would be refused with
// "service-has-no-ui". The manifest's `provides` address matches this path.
const route = createMcpRoute(buildShellServer);

/**
 * One line per tool call, with the JSON-RPC id, so a burst of identical calls
 * can be read: distinct ids are calls the model emitted, a repeated id is a
 * client retrying.
 */
export const ALL: typeof route = async (ctx) => {
  let label = '';
  if (ctx.request.method === 'POST') {
    try {
      const body = await ctx.request.clone().json() as { id?: unknown; method?: string; params?: { name?: string } };
      if (body?.method === 'tools/call') label = `tools/call ${body.params?.name ?? '?'} id=${String(body.id)}`;
    } catch { /* not JSON — the transport will say so */ }
  }
  const t0 = Date.now();
  const res = await route(ctx);
  if (label) console.log(`[mcp] ${label} ${res.status} ${Date.now() - t0}ms`);
  return res;
};
