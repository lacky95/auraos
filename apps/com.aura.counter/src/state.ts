/**
 * Per-instance counter state. Lives in the single Astro process for this instance.
 * Multiple activities (views) share this counter — incrementing in one shows up
 * live in all activities via SSE.
 */
type CounterState = {
  value: number;
  activities: Set<string>;
  listeners: Set<() => void>;
};

const KEY = '__aura_counter_state__';
const g = globalThis as typeof globalThis & { [KEY]?: CounterState };

if (!g[KEY]) {
  g[KEY] = { value: 0, activities: new Set(), listeners: new Set() };
}

export const state = g[KEY]!;

export function applyAction(action: 'inc' | 'dec' | 'reset'): void {
  if (action === 'inc')   state.value += 1;
  if (action === 'dec')   state.value -= 1;
  if (action === 'reset') state.value  = 0;
  for (const cb of state.listeners) { try { cb(); } catch {} }
}

export function snapshot() {
  return { value: state.value, activityCount: state.activities.size };
}
