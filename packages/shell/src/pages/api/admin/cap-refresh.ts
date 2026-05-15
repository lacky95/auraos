import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';

/**
 * Hot-refresh the per-instance tool allowlist for every running instance of
 * `appId`. Called by `aura cap grant` / `aura cap revoke` so live apps pick
 * up the new symlink set in /aura/my-tools without a proot respawn (the bind
 * is at the directory level, so symlink mutations are immediately visible).
 *
 * Returns the list of refreshed instance IDs.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: { appId?: string };
  try { body = await request.json(); } catch { body = {}; }
  const appId = body.appId;
  if (!appId) return new Response(JSON.stringify({ error: '`appId` required' }), { status: 400 });

  try {
    const refreshed = getAppManager().refreshInstanceTools(appId);
    return new Response(JSON.stringify({ ok: true, appId, refreshed }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
