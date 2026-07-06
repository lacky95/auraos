import type { APIRoute } from 'astro';
import { defaultKv } from '@aura/kv-store';

/**
 * POST /api/os/lock — arm the lock screen. No body.
 *
 * Locking rides on the `os/lockscreen` KV key: the shell's LockScreenOverlay
 * polls it once a second and shows the blackout when `lockAt` increases. We
 * merge a fresh `lockAt` onto whatever config is stored so the appearance
 * (text / position / clock / zoom) is preserved.
 *
 * Pair: POST /api/os/unlock.
 */
export const POST: APIRoute = async () => {
  const kv = defaultKv();
  try {
    const current = (await kv.getValue<Record<string, unknown>>('os', 'lockscreen')) ?? {};
    const value = { ...current, lockAt: Date.now() };
    await kv.set('os', 'lockscreen', value);
    return json({ locked: true, at: value.lockAt });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  } finally {
    await kv.close().catch(() => undefined);
  }
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
