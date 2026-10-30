/**
 * Frontend log switch — where the shell's `aura.log` filter comes from.
 *
 * The filter itself is @aura/core/logger's (`shell:*`, `shell:boot,keymap`,
 * `*@warn`, `-noisy` …; read from localStorage `aura.log` on every call).
 * Three ways to set it, highest precedence first:
 *
 *   1. `?log=<filter>` on the desktop URL — this page load wins over
 *      everything; also written to localStorage so it sticks. `?log=off`
 *      clears it. Handled by the inline head script in OSLayout.astro
 *      (it has to run before any module logs) via `applyUrlLogParam`.
 *   2. KV `os/frontendLog` — Settings → General → Frontend logging. Mirrored
 *      into localStorage at boot and live on `kv:changed`, unless a `?log=`
 *      param set the filter for this page load.
 *   3. Whatever localStorage `aura.log` already holds (DevTools).
 */
import { subscribeKv } from './kvClient.ts';

export const LOG_STORAGE_KEY = 'aura.log';
export const LOG_KV_KEY = 'frontendLog';
const OFF = new Set(['off', '0', 'none', 'false']);

interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

/**
 * Apply `?log=` from `search` to `storage`. Returns true when the URL decided
 * the filter for this page load (so the KV mirror must not override it).
 */
export function applyUrlLogParam(search: string, storage: StorageLike): boolean {
  let value: string | null;
  try { value = new URLSearchParams(search).get('log'); } catch { return false; }
  if (value === null) return false;
  if (OFF.has(value.trim().toLowerCase()) || value.trim() === '') storage.removeItem(LOG_STORAGE_KEY);
  else storage.setItem(LOG_STORAGE_KEY, value.trim());
  return true;
}

/** Mirror a KV value into storage: a non-empty string sets it, anything else clears it. */
export function applyKvLogValue(value: unknown, storage: StorageLike): void {
  if (typeof value === 'string' && value.trim() && !OFF.has(value.trim().toLowerCase())) {
    storage.setItem(LOG_STORAGE_KEY, value.trim());
  } else {
    storage.removeItem(LOG_STORAGE_KEY);
  }
}

/** Boot: mirror KV `os/frontendLog` (now and on change) unless `?log=` won. */
export function startLogControl(): void {
  if (typeof window === 'undefined') return;
  const fromUrl = (window as unknown as { __auraLogFromUrl?: boolean }).__auraLogFromUrl === true;
  let storage: StorageLike;
  try { storage = window.localStorage; } catch { return; }
  if (fromUrl) return;
  // Plain fetch, not getKvValue: an unset key is the normal case and must not
  // go through kvClient's boot-race 404 retries. Unset → keep the local filter.
  void fetch(`/api/kv/os/${LOG_KV_KEY}`)
    .then((r) => (r.ok ? r.json() as Promise<{ value?: unknown }> : null))
    .then((body) => { if (body) applyKvLogValue(body.value, storage); })
    .catch(() => { /* KV unreachable — keep the local filter */ });
  subscribeKv({ namespace: 'os', key: LOG_KV_KEY }, (ev) => applyKvLogValue(ev.value, storage));
}
