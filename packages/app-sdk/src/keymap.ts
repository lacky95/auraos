/**
 * `osClient.keymap` — keyboard-action API for app iframes.
 *
 * Apps declare actions in `app.manifest.json` (`keymapActions`). At runtime
 * they register handlers via `osClient.keymap.on(id, handler)`. The handler
 * fires when the user's currently-bound combo for that action is pressed,
 * regardless of whether the user has remapped the combo in Settings —
 * combos are the user's prerogative, action ids are the API contract.
 *
 * All transport goes through `postMessage` envelopes the shell understands:
 *   • `aura.keymap.subscribe` (out)  — tell the shell "I'm listening for these
 *                                      actions, refresh my claim list".
 *   • `aura.action.fire`      (in)   — shell forwarded a key combo back as
 *                                      the matching app-scope actionId.
 *   • `aura.keymap.changed`   (in)   — bindings refreshed; rerun onChange cbs.
 *
 * The current combo for any action is exposed synchronously via
 * `getBinding()` (read off proxy-injected meta tags), so menu shortcut
 * labels can render before any HTTP round-trip.
 */

import type { OsClient } from './OsClient.js';

export interface KeymapHandlerCtx {
  /** Fully-qualified action id (`app.com.aura.notepad.save`). */
  actionId: string;
  /** The combo the user actually pressed. */
  combo:    string;
}

export type KeymapHandler = (ctx: KeymapHandlerCtx) => void | Promise<void>;

export interface KeymapChangeInfo {
  actionId: string;
  oldCombo: string | null;
  newCombo: string | null;
}

type Bindings = { [actionId: string]: string | null };

export class KeymapApi {
  private handlers = new Map<string, KeymapHandler>();
  private bindings: Bindings = {};
  private changeListeners = new Set<(info: KeymapChangeInfo) => void>();
  private appIdCache: string | null = null;

  constructor(_client: OsClient) {
    if (typeof window === 'undefined') return;
    this.hydrateFromMeta();
    window.addEventListener('message', this.handleMessage);
  }

  /**
   * Register a handler for an action declared in `app.manifest.json`.
   *
   * `actionId` is the manifest-local short id (e.g. `"save"`) — the SDK
   * prefixes it with `app.<appId>.` internally so it matches what the shell
   * dispatcher stores. Passing the fully-qualified id directly (apps that
   * want to react to OS actions) also works.
   *
   * Returns an unsubscribe function. Multiple `on()` calls for the same
   * action replace the previous handler — one handler per action by design,
   * since the combo is global and chaining is ambiguous.
   */
  on(actionId: string, handler: KeymapHandler): () => void {
    const full = this.fullId(actionId);
    this.handlers.set(full, handler);
    this.notifySubscribe();
    return () => this.off(actionId);
  }

  /** Remove the handler for an action. No-op if not registered. */
  off(actionId: string): void {
    const full = this.fullId(actionId);
    if (!this.handlers.delete(full)) return;
    this.notifySubscribe();
  }

  /**
   * Current combo bound to an action, or `null` if unbound. Accepts the
   * manifest-local id or the fully-qualified id (OS actions like
   * `aura.launcher.toggle`).
   *
   * Reads from a meta-tag snapshot the proxy injects on every page load,
   * so it's synchronous from the first render. Refreshed live on every
   * `aura.keymap.changed` postMessage from the shell.
   */
  getBinding(actionId: string): string | null {
    const full = this.fullId(actionId);
    if (full in this.bindings)    return this.bindings[full] ?? null;
    if (actionId in this.bindings) return this.bindings[actionId] ?? null;
    return null;
  }

  /** Subscribe to remap events. Returns an unsubscribe function. */
  onChange(cb: (info: KeymapChangeInfo) => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  // ---- Internals ------------------------------------------------------

  private fullId(actionId: string): string {
    if (actionId.startsWith('aura.') || actionId.startsWith('app.')) return actionId;
    return `app.${this.getAppId()}.${actionId}`;
  }

  private getAppId(): string {
    if (this.appIdCache) return this.appIdCache;
    if (typeof document === 'undefined') return 'unknown';
    const v = document.querySelector('meta[name="aura-app-id"]')?.getAttribute('content');
    this.appIdCache = v && v.length > 0 ? v : 'unknown';
    return this.appIdCache;
  }

  private hydrateFromMeta(): void {
    if (typeof document === 'undefined') return;
    const meta = document.querySelector('meta[name="aura-keymap-bindings"]');
    const raw  = meta?.getAttribute('content');
    if (!raw) return;
    try { this.bindings = JSON.parse(raw) as Bindings; }
    catch { /* malformed — leave bindings empty */ }
  }

  private notifySubscribe(): void {
    if (typeof window === 'undefined' || window.parent === window) return;
    try {
      window.parent.postMessage({
        type:      'aura.keymap.subscribe',
        appId:     this.getAppId(),
        actionIds: Array.from(this.handlers.keys()),
      }, '*');
    } catch { /* parent gone */ }
  }

  private handleMessage = (ev: MessageEvent): void => {
    const d = ev.data as { type?: string } | null;
    if (!d || typeof d !== 'object') return;

    if (d.type === 'aura.action.fire') {
      const m = d as { type: string; actionId?: unknown; combo?: unknown };
      if (typeof m.actionId !== 'string' || typeof m.combo !== 'string') return;
      const handler = this.handlers.get(m.actionId);
      if (!handler) return;
      try {
        const res = handler({ actionId: m.actionId, combo: m.combo });
        if (res && typeof (res as Promise<unknown>).then === 'function') {
          (res as Promise<void>).catch((err) => console.warn(`[KeymapApi] handler ${m.actionId} rejected:`, err));
        }
      } catch (err) {
        console.warn(`[KeymapApi] handler ${m.actionId} threw:`, err);
      }
      return;
    }

    if (d.type === 'aura.keymap.changed') {
      const m = d as { type: string; bindings?: unknown };
      if (!m.bindings || typeof m.bindings !== 'object') return;
      const next = m.bindings as Bindings;
      const prev = this.bindings;
      this.bindings = next;
      const seen = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);
      for (const id of seen) {
        const oldC = prev[id] ?? null;
        const newC = next[id] ?? null;
        if (oldC === newC) continue;
        for (const cb of this.changeListeners) {
          try { cb({ actionId: id, oldCombo: oldC, newCombo: newC }); }
          catch (err) { console.warn('[KeymapApi] onChange listener threw:', err); }
        }
      }
    }
  };
}
