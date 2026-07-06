import type { APIRoute } from 'astro';
import { defaultKv } from '@aura/kv-store';

/**
 * POST /api/os/unlock — dismiss the lock screen. No body.
 *
 * Mirror of /api/os/lock: bumps an `unlockAt` timestamp on `os/lockscreen`.
 * The LockScreenOverlay's poll deactivates when `unlockAt` increases. Config
 * (text / position / clock / zoom) is preserved.
 */
export const POST: APIRoute = async () => {
  const kv = defaultKv();
  try {
    const current = (await kv.getValue<Record<string, unknown>>('os', 'lockscreen')) ?? {};
    const value = { ...current, unlockAt: Date.now() };
    await kv.set('os', 'lockscreen', value);
    return json({ locked: false, at: value.unlockAt });
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
