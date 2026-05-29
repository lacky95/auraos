import { OsEventBus } from '@aura/core';
import { defaultKv } from '@aura/kv-store';

/**
 * Update the MRU (most-recently-used) stamp for `appId` to "now".
 *
 * Best-effort: a KV write failure is logged and swallowed — dock ordering is
 * a nicety, never worth failing a launch / activity-open over. Emits
 * `app:mruChanged` (relayed to the browser by the sioPlugin) so the dock can
 * re-sort its tiles live without a refetch round-trip.
 *
 * Called from every "user brought this app to the foreground" choke point so
 * the dock's recency reflects actual use rather than only the first launch:
 *   • POST /api/apps/<id>/start            — cold launch
 *   • POST /api/instances/<id>/activities  — opening an activity on an
 *                                            already-running instance (the
 *                                            common case — most apps stay
 *                                            running, so re-clicking a dock
 *                                            tile reuses the instance and
 *                                            never hits /start).
 */
export async function bumpMru(appId: string): Promise<void> {
  try {
    const kv = defaultKv();
    try {
      const map = (await kv.getValue<Record<string, number>>('os', 'app-mru')) ?? {};
      map[appId] = Date.now();
      await kv.set('os', 'app-mru', map);
      // Topic the sioPlugin already relays — see astro.config.mjs EVENT_TYPES.
      OsEventBus.emit('app:mruChanged', { appId, at: map[appId] });
    } finally {
      await kv.close().catch(() => undefined);
    }
  } catch (err) {
    console.warn(`[appMru] bump failed for ${appId}: ${(err as Error).message}`);
  }
}
