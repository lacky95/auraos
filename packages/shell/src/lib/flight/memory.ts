/**
 * Free-flight activities: remember where the user last had an app's flight.
 *
 * Per app + page (`appId` + the flight's path), the last mode, tab anchor,
 * edge-drawer size and free rect are kept in the OS KV (`os/flight-memory`).
 * A flight opened again — the app's "pop out" button, a window taking off —
 * comes back there instead of at the default (right edge, middle). Whatever
 * the app asks for explicitly still wins; a reopened flight starts open, not
 * folded. Fed by lib/flight/service.ts from the flight events.
 */

import { defaultKv } from '@aura/kv-store';
import type { FlightState } from '@aura/core';

const KV_KEY = 'flight-memory';
const MAX_ENTRIES = 200;

export type FlightMemory = Pick<FlightState, 'mode' | 'anchor' | 'edgeSize' | 'rect'>;

const G = Symbol.for('aura.flight.memory');
type Store = { map: Map<string, FlightMemory & { at: number }>; loaded: Promise<void> | null; timer: ReturnType<typeof setTimeout> | null };
const store = (): Store => ((globalThis as typeof globalThis & { [G]?: Store })[G] ??= { map: new Map(), loaded: null, timer: null });

const keyOf = (appId: string, path: string) => `${appId} ${(path || '/').split('?')[0]}`;

async function withKv<T>(fn: (kv: ReturnType<typeof defaultKv>) => Promise<T>): Promise<T> {
  const kv = defaultKv();
  try { return await fn(kv); } finally { await kv.close().catch(() => undefined); }
}

/** Load the stored memory once per process (idempotent). */
export function loadFlightMemory(): Promise<void> {
  const s = store();
  s.loaded ??= withKv((kv) => kv.getValue<Record<string, FlightMemory & { at: number }>>('os', KV_KEY))
    .then((saved) => {
      for (const [k, v] of Object.entries(saved ?? {})) if (!s.map.has(k)) s.map.set(k, v);
    })
    .catch((err: unknown) => { console.warn(`[flight] memory load failed: ${(err as Error).message}`); });
  return s.loaded;
}

function scheduleSave(): void {
  const s = store();
  if (s.timer) return;
  s.timer = setTimeout(() => {
    s.timer = null;
    // Keep the newest entries only.
    const entries = [...s.map.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
    void withKv((kv) => kv.set('os', KV_KEY, Object.fromEntries(entries)))
      .catch((err: unknown) => console.warn(`[flight] memory save failed: ${(err as Error).message}`));
  }, 1_000);
}

/** Record a flight's current place (call on every flight change). */
export function noteFlight(appId: string, path: string, f: Partial<FlightState> | undefined): void {
  if (!f?.anchor) return;
  const entry: FlightMemory & { at: number } = {
    mode: f.mode ?? 'free',
    anchor: { ...f.anchor },
    edgeSize: f.edgeSize ? { ...f.edgeSize } : { length: 480, depth: 360 },
    rect: f.rect ? { ...f.rect } : null,
    at: Date.now(),
  };
  const s = store();
  const k = keyOf(appId, path);
  const prev = s.map.get(k);
  if (prev && JSON.stringify({ ...prev, at: 0 }) === JSON.stringify({ ...entry, at: 0 })) return;
  s.map.set(k, entry);
  scheduleSave();
}

/** Where this app's flight on `path` last was, or null. */
export function rememberedFlight(appId: string, path: string): FlightMemory | null {
  const m = store().map.get(keyOf(appId, path));
  if (!m) return null;
  const { at: _at, ...rest } = m;
  return rest;
}
