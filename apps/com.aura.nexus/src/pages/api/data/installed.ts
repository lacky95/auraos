/** Content provider for `data:com.aura.nexus:read` consumers. Returns the
 *  same shape the shell's /api/nexus/installed returns, but with this app's
 *  dataProvider authority handling permissions. */
import type { APIRoute } from 'astro';

const OS_API = process.env['OS_API_BASE'] ?? 'http://127.0.0.1:3000';

export const GET: APIRoute = async () => {
  const res = await fetch(`${OS_API}/api/nexus/installed`, {
    signal: AbortSignal.timeout(5_000),
  });
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json' },
  });
};
