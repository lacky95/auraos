/**
 * Clicks on bar buttons that land before their component's script runs.
 *
 * The status bar and dock are server-rendered, so they show (and can be
 * clicked) long before the module scripts that wire them up have loaded.
 * An inline capture listener in OSLayout's <head> records clicks on any
 * element with `data-early-click="<name>"` until that name is claimed; the
 * component then replays a waiting click once, as soon as it can handle it.
 *
 *   <button data-early-click="launcher">…</button>
 *   claimEarlyClicks('launcher', () => openPanel());
 */
import { mark } from './bootTimeline.ts';

interface EarlyWindow {
  __auraEarlyClicks?: string[];
  __auraEarlyReady?: Record<string, boolean>;
}

/**
 * From now on `name` is handled by its component (the inline recorder stops
 * queueing it). Runs `run` once if a click came in before.
 */
export function claimEarlyClicks(name: string, run: () => void): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as EarlyWindow;
  (w.__auraEarlyReady ??= {})[name] = true;
  const queued = w.__auraEarlyClicks ?? [];
  if (!queued.includes(name)) return;
  w.__auraEarlyClicks = queued.filter((n) => n !== name);
  mark(`early-click:${name}`);
  run();
}
