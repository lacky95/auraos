import type { APIRoute } from 'astro';
import { defaultKv } from '@aura/kv-store';
import { readUserPrefValue } from '@aura/core';
import { localOwnerId, requestUserId } from '../../../../lib/userContext.js';

/**
 * Read the per-app MRU (most-recently-used) timestamp map. Used by the
 * Dock's live re-order when an app:mruChanged event names an appId NOT
 * currently in the dock — we need the full ordering to know which tile
 * to demote. Stamped by `/api/apps/<id>/start` on every successful launch.
 *
 *   GET → `{ mru: { [appId]: epochMs } }`
 *
 * Apps the user has never launched are absent from the map; callers treat
 * a missing entry as `0` (oldest) so newcomers fall through to the
 * alphabetical tiebreak.
 */

export const GET: APIRoute = async ({ request }) => {
  let mru: Record<string, number> = {};
  try {
    const kv = defaultKv();
    try { mru = (await readUserPrefValue<Record<string, number>>(kv, (await requestUserId(request)) ?? localOwnerId(), 'app-mru')) ?? {}; }
    finally { await kv.close().catch(() => undefined); }
  } catch (err) {
    console.warn(`[apps/mru] read failed: ${(err as Error).message}`);
  }
  return new Response(JSON.stringify({ mru }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
