/**
 * Per-instance counter state. Lives in the single Astro process for this instance.
 * Multiple activities (views) share this counter — incrementing in one shows up
 * live in all activities via SSE.
 *
 * Persistence: the counter value is written to /data/counter.json on every
 * mutation and loaded back on module init, so it survives container restarts.
 * /data is bind-mounted by the OS to the per-instance data directory.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type CounterState = {
  value: number;
  activities: Set<string>;
  listeners: Set<() => void>;
};

const DATA_DIR  = process.env['AURA_DATA_DIR'] ?? '/data';
const DATA_FILE = join(DATA_DIR, 'counter.json');

function loadFromDisk(): number {
  try {
    if (existsSync(DATA_FILE)) {
      const raw = JSON.parse(readFileSync(DATA_FILE, 'utf-8')) as { value?: number };
      if (typeof raw.value === 'number') return raw.value;
    }
  } catch { /* first run — start at 0 */ }
  return 0;
}

function saveToDisk(value: number): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DATA_FILE, JSON.stringify({ value }), 'utf-8');
  } catch { /* best-effort */ }
}

const KEY = '__aura_counter_state__';
const g = globalThis as typeof globalThis & { [KEY]?: CounterState };

if (!g[KEY]) {
  g[KEY] = { value: loadFromDisk(), activities: new Set(), listeners: new Set() };
}

export const state = g[KEY]!;

export function applyAction(action: 'inc' | 'dec' | 'reset'): void {
  if (action === 'inc')   state.value += 1;
  if (action === 'dec')   state.value -= 1;
  if (action === 'reset') state.value  = 0;
  saveToDisk(state.value);
  for (const cb of state.listeners) { try { cb(); } catch {} }
}

export function snapshot() {
  return { value: state.value, activityCount: state.activities.size };
}
