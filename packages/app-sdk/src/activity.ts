/**
 * `osClient.activity` — in-place activity navigation.
 *
 * Two launch modes for activities in AuraOS:
 *
 *   • **new-activity** (existing path): POST `/api/instances/<id>/activities`
 *     spawns a brand-new activity that gets its own slot in the layout.
 *     Use for parallel views (multiple notepad docs, multiple terminals).
 *
 *   • **navigate** (this API): the current activity's iframe URL changes
 *     in place; the OS records the previous path on a per-activity back
 *     stack so OS Back returns to it. Use for sequential views inside a
 *     single panel (Settings tile → subpage → OS Back returns to overview;
 *     wizard steps; drill-down).
 *
 * The OS owns the back stack — apps just call `navigate()` for forward
 * steps and either rely on OS Back (default Escape) or call `back()`
 * from their own UI to pop manually.
 */

import type { OsClient } from './OsClient.js';

export interface NavigateOptions {
  /** Title to show in the slot chrome after navigation. */
  title?:        string;
  /**
   * Whether the previous path is recorded on the back stack. Default true.
   * Set false for redirects / error pages / anything that shouldn't be
   * reachable via Back.
   */
  pushHistory?:  boolean;
}

export class ActivityApi {
  constructor(private client: OsClient) { /* no init */ }

  /**
   * Navigate the current activity's iframe to `path`, pushing the
   * previous path onto the OS back stack. Pressing OS Back (default
   * `Escape`) returns to the previous path.
   *
   * The path is relative to the app's own routes — `/theme`,
   * `/wizard/step-2`, etc. The OS rewrites it to the proxy URL.
   *
   * Returns true on success, false when the activity id couldn't be
   * resolved (the iframe is running without an activity context).
   */
  async navigate(path: string, opts: NavigateOptions = {}): Promise<boolean> {
    return this.post(path, { ...opts, pushHistory: opts.pushHistory !== false });
  }

  /**
   * Like `navigate()` but does NOT record the previous path on the back
   * stack. Use for redirects or to clear stale steps.
   */
  async replace(path: string, opts: NavigateOptions = {}): Promise<boolean> {
    return this.post(path, { ...opts, pushHistory: false });
  }

  /**
   * Pop one step on the OS back stack manually. Useful for in-app
   * back chips that don't want to rely on the OS's Escape binding.
   * No-op when the stack is empty (the app's own Back handler should
   * call `client.finish()` or let OS Back fall through).
   */
  async back(): Promise<void> {
    const id = this.getActivityId();
    if (!id) return;
    await fetch(`${this.osApiBase()}/api/activities/${encodeURIComponent(id)}/back`, {
      method: 'POST',
    }).catch(() => undefined);
  }

  /**
   * Jump directly to a specific position in the back stack. Index 0 is the
   * oldest entry (the entry the user started from); higher indices are
   * more recent. Apps that render their own breadcrumb chrome use this to
   * implement crumb clicks. No-op on out-of-range indices.
   */
  async backTo(index: number): Promise<void> {
    const id = this.getActivityId();
    if (!id) return;
    await fetch(`${this.osApiBase()}/api/activities/${encodeURIComponent(id)}/back-to`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ index }),
    }).catch(() => undefined);
  }

  /**
   * Switch the OS-rendered breadcrumb chrome on/off for the current
   * activity. Defaults to `'os'` for new activities — apps that ship
   * their own header (media player, photo editor) call this with
   * `'off'` to suppress the OS trail without breaking the underlying
   * back-stack semantics. Pair with `getHistory()` if you want to
   * render your own breadcrumb on top of the OS-tracked stack.
   */
  async setBreadcrumb(mode: 'os' | 'off'): Promise<void> {
    const id = this.getActivityId();
    if (!id) return;
    await fetch(`${this.osApiBase()}/api/activities/${encodeURIComponent(id)}/breadcrumb`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ mode }),
    }).catch(() => undefined);
  }

  /**
   * Current in-activity back stack as `{ path, title }` pairs, read off
   * the proxy-injected `<meta name="aura-activity-history">` tag. Apps
   * that opt out of the OS breadcrumb (`setBreadcrumb('off')`) use this
   * to render their own trail. Refreshed on every iframe load (which is
   * how navigations happen — the OS swaps the iframe `src`, the new doc
   * reads the new meta).
   */
  getHistory(): Array<{ path: string; title?: string }> {
    if (typeof document === 'undefined') return [];
    const raw = document.querySelector('meta[name="aura-activity-history"]')?.getAttribute('content');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((e): e is { path: string; title?: string } =>
        e !== null && typeof e === 'object' && typeof (e as { path?: unknown }).path === 'string',
      );
    } catch { return []; }
  }

  /** Current activity id, or null when no activity context is available. */
  getActivityId(): string | null {
    if (typeof process !== 'undefined' && process.env) {
      const v = process.env['APP_ACTIVITY_ID'];
      if (v) return v;
    }
    if (typeof document === 'undefined') return null;
    return document.querySelector('meta[name="aura-activity-id"]')?.getAttribute('content') ?? null;
  }

  // ---- internals ---------------------------------------------------------

  private async post(path: string, opts: NavigateOptions): Promise<boolean> {
    const id = this.getActivityId();
    if (!id) return false;
    const res = await fetch(`${this.osApiBase()}/api/activities/${encodeURIComponent(id)}/navigate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ path, ...opts }),
    }).catch(() => null);
    return !!res?.ok;
  }

  private osApiBase(): string {
    // Browser: same-origin (the iframe is proxied through the shell). Node:
    // OS_API_BASE env var from ProotRunner. Matches the convention used by
    // OsClient.startIntent and friends.
    if (typeof window !== 'undefined') return '';
    return process.env['OS_API_BASE'] ?? 'http://localhost:3000';
  }
}
