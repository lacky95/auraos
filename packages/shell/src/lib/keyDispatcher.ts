/**
 * Browser-side singleton that turns keyboard input into action dispatches.
 *
 * Two input sources:
 *   1. The shell's own `keydown` listener (installed in OSLayout) — fires for
 *      every keypress while no iframe has focus.
 *   2. App iframes forwarding only **claimed** combos via postMessage — the
 *      proxy-injected forwarder consults a per-iframe claim list and lets
 *      everything else fall through to the browser (the "browser-default
 *      guarantee").
 *
 * Action lookup:
 *   - User bindings (KV `os/keymap`) shadow the registry's defaults.
 *   - Scope precedence is `os-always` > `os-modifier` > mode-match
 *     (`os-nav` in Nav mode, `app` when an iframe forwarded the combo).
 *   - The handler bound via `bind(actionId, handler)` is invoked; if no
 *     handler is registered the combo is silently dropped (we still know
 *     about the action, just nothing to run).
 *
 * Claim list:
 *   - The list of combos the OS wants the iframe to forward up. Derived from
 *     OS-scope actions plus any app-scope actions a focused app subscribed
 *     to. Re-broadcast to iframes when bindings or subscriptions change.
 */

// Import from the `/keymap` subpath, NOT the bare `@aura/core` barrel —
// the barrel pulls AppManager, which transitively imports chokidar + node:fs,
// and Vite explodes when those land in a browser bundle. The keymap module
// is pure data + tiny pure functions, safe to bundle anywhere.
import {
  comboFromEvent,
  canonicalize,
  expandCombo,
  emptyModifierState,
  updateModifierState,
  isModifierCode,
  type KeyAction,
  type KeyScope,
  type KeyEventLike,
  type ModifierState,
  type OsKeymapState,
} from '@aura/core/keymap';
import { createLogger } from '@aura/core/logger';

const log = createLogger('keymap');

export type DispatchMode = 'nav' | 'app';
export type DispatchSource = 'keyboard' | 'iframe';

export interface DispatchCtx {
  event:  KeyboardEvent | null;
  combo:  string;
  appId:  string | null;     // appId of focused iframe (when source='iframe')
  source: DispatchSource;
}

export type DispatchHandler = (ctx: DispatchCtx) => boolean | void | Promise<boolean | void>;

export interface DispatchResult {
  /** The action that matched. Null when nothing did. */
  actionId: string | null;
  /** Whether a registered handler ran. False when matched but no handler bound (e.g. app-scope actions whose handler lives inside the app's iframe). */
  fired:    boolean;
}

interface ResolvedAction {
  action: KeyAction;
  /** The combo currently bound to this action (defaults are honored unless the user overrode). */
  combo:  string | null;
}

export class KeyDispatcher {
  // App mode is the steady state — the user is interacting with the focused
  // iframe and expects every key (Enter, arrows, letters) to reach it
  // natively. Nav mode is the transient OS-overlay state entered via Home
  // (`aura.nav.home`) or Back (`aura.nav.back`), and exited when the user
  // presses Enter on a window or clicks back into an app. Defaulting to
  // 'nav' would silently claim Enter + arrows from every iframe on first
  // load, breaking terminals, text inputs, and editors out of the box.
  private mode: DispatchMode = 'app';
  private actions: KeyAction[] = [];
  private state: OsKeymapState = { bindings: {}, appOverlays: {} };
  private handlers = new Map<string, DispatchHandler>();
  private modeListeners = new Set<(mode: DispatchMode) => void>();
  private claimListeners = new Set<(claims: { os: string[]; perApp: Map<string, string[]> }) => void>();
  // Side-specific modifier state — which physical Ctrl/Alt/Shift/Super
  // is held. Updated from the modifier-key keydown/keyup events themselves
  // (see ingestModifierEvent) so a subsequent non-modifier press can
  // emit `RShift+Enter` rather than the side-agnostic `Shift+Enter`.
  private modifierState: ModifierState = emptyModifierState();

  // ---- State setters --------------------------------------------------

  setMode(mode: DispatchMode): void {
    if (mode === this.mode) return;
    log.debug('setMode', mode);
    this.mode = mode;
    for (const cb of this.modeListeners) {
      try { cb(mode); } catch (err) { log.warn('mode listener threw:', err); }
    }
    // Claim list depends on mode (os-nav combos are mode-gated). Push the
    // updated list to every iframe so a Nav-mode flip immediately gives
    // the OS its arrow keys back (and the reverse — App-mode flip returns
    // Enter/arrows to the focused app).
    this.notifyClaims();
  }

  getMode(): DispatchMode { return this.mode; }

  onModeChange(cb: (mode: DispatchMode) => void): () => void {
    this.modeListeners.add(cb);
    return () => this.modeListeners.delete(cb);
  }

  /**
   * Replace the registry catalogue. Called once during init from the
   * `/api/os/keymap` SSR endpoint, and after any AppManager reload that
   * could have added or removed app actions.
   */
  setActions(actions: readonly KeyAction[]): void {
    this.actions = [...actions];
    this.notifyClaims();
  }

  /**
   * Replace the persisted user state (overlays). Called on init and on every
   * `kv:changed os/keymap` SSE event.
   */
  setState(state: OsKeymapState): void {
    this.state = {
      bindings:    { ...(state.bindings    ?? {}) },
      appOverlays: { ...(state.appOverlays ?? {}) },
    };
    this.notifyClaims();
  }

  getState(): OsKeymapState {
    return {
      bindings:    { ...this.state.bindings },
      appOverlays: Object.fromEntries(
        Object.entries(this.state.appOverlays).map(([k, v]) => [k, { ...v }]),
      ),
    };
  }

  // ---- Handler registration -------------------------------------------

  bind(actionId: string, handler: DispatchHandler): () => void {
    this.handlers.set(actionId, handler);
    return () => { if (this.handlers.get(actionId) === handler) this.handlers.delete(actionId); };
  }

  hasHandler(actionId: string): boolean { return this.handlers.has(actionId); }

  // ---- Dispatch -------------------------------------------------------

  /**
   * Process a keydown from the shell's own window. Returns the matched
   * action (if any) and whether a registered handler ran. Modifier-key
   * keydowns also update the side-specific modifier state so the next
   * non-modifier press resolves to the precise (`RShift+Enter`) form.
   */
  handleKeyEvent(event: KeyboardEvent): DispatchResult {
    if (isModifierCode(event.code)) {
      // For a Pressed modifier we update the tracked state. We still
      // emit a combo (it equals event.code) — a binding to e.g. `AltRight`
      // can fire on its own.
      this.modifierState = updateModifierState(this.modifierState, event.code, true);
    }
    const evLike: KeyEventLike = {
      code:     event.code,
      key:      event.key,
      ctrlKey:  event.ctrlKey,
      altKey:   event.altKey,
      shiftKey: event.shiftKey,
      metaKey:  event.metaKey,
    };
    const combo = comboFromEvent(evLike, this.modifierState);
    if (!combo) return { actionId: null, fired: false };
    return this.resolveAndFire(combo, { event, combo, appId: null, source: 'keyboard' });
  }

  /**
   * Modifier keyup — clears the matching slot in the side-specific state
   * so a later non-modifier press doesn't accidentally inherit a stale
   * side qualifier. Call from a top-level `keyup` listener.
   */
  handleModifierKeyUp(event: KeyboardEvent): void {
    if (!isModifierCode(event.code)) return;
    this.modifierState = updateModifierState(this.modifierState, event.code, false);
  }

  /**
   * Window-blur reset. When the page loses focus mid-modifier-hold (alt-tab
   * away while holding Shift), we never see the keyup. Clear everything so
   * the next focus doesn't think a phantom modifier is still pressed.
   */
  resetModifierState(): void {
    this.modifierState = emptyModifierState();
  }

  /**
   * Process a combo forwarded up from an iframe. The iframe is responsible
   * for canonicalizing + only forwarding combos in its claim list, but we
   * canonicalize again here defensively in case the script gets out of sync.
   */
  handleIframeCombo(combo: string, appId: string): DispatchResult {
    let canon = combo;
    try { canon = canonicalize(combo); } catch { return { actionId: null, fired: false }; }
    return this.resolveAndFire(canon, { event: null, combo: canon, appId, source: 'iframe' });
  }

  // ---- Claim list -----------------------------------------------------

  /**
   * Build the combo claim list for an iframe — the set of canonical combos
   * the iframe forwarder will preventDefault + bubble up to the shell.
   *
   * Mode-aware: `os-nav` combos (arrows, Enter) are only claimed when the
   * shell is actually in Nav mode. Claiming them in App mode would silently
   * eat every Enter keypress in a focused terminal, every arrow press in a
   * focused text editor, etc. — breaking the browser-default guarantee for
   * combos that DO have a meaningful Nav-mode dispatch.
   *
   * The claim list is rebroadcast on every `setMode` flip (see notifyClaims
   * wiring), so a switch into Nav mode immediately gives the OS its arrow
   * keys back without an iframe reload.
   *
   *   • `os-always` / `os-modifier` — always claimed.
   *   • `os-nav`                    — claimed only when `mode === 'nav'`.
   *   • `app`                       — claimed when the action's id matches
   *                                   the focused appId (handlers live
   *                                   inside the app's iframe via SDK).
   */
  getClaimListForApp(appId: string | null): string[] {
    const set = new Set<string>();
    for (const a of this.actions) {
      const combo = this.effectiveCombo(a, appId);
      if (!combo) continue;
      if (a.scope === 'os-always' || a.scope === 'os-modifier') {
        set.add(combo);
        continue;
      }
      if (a.scope === 'os-nav') {
        if (this.mode === 'nav') set.add(combo);
        continue;
      }
      // app-scope actions: only claim those belonging to the focused app.
      if (a.scope === 'app' && appId && a.id.startsWith(`app.${appId}.`)) {
        set.add(combo);
      }
    }
    return [...set];
  }

  onClaimListChange(cb: (claims: { os: string[]; perApp: Map<string, string[]> }) => void): () => void {
    this.claimListeners.add(cb);
    return () => this.claimListeners.delete(cb);
  }

  /**
   * Snapshot of effective combos, for an iframe's `<meta name="aura-keymap-
   * bindings">` rehydration. Apps the user hasn't customised return their
   * defaults; per-app overlays apply where present.
   */
  getBindingsForApp(appId: string | null): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const a of this.actions) {
      if (a.scope === 'app' && (!appId || !a.id.startsWith(`app.${appId}.`))) continue;
      out[a.id] = this.effectiveCombo(a, appId);
    }
    return out;
  }

  // ---- Internals ------------------------------------------------------

  /**
   * Look up the action(s) that match a combo + the dispatcher's current
   * mode. Apply scope precedence; fire the highest-scoring handler. Returns
   * true if a handler ran.
   */
  private resolveAndFire(combo: string, ctx: DispatchCtx): DispatchResult {
    // Expand the physical event combo into all the less-specific forms it
    // also satisfies. A binding to "Shift+Enter" should fire on RShift+Enter
    // even though comboFromEvent emitted the side-specific RShift+Enter.
    // First entry of `candidates` is the most-specific (input itself).
    const candidates = new Set(expandCombo(combo));
    const matches: ResolvedAction[] = [];
    for (const a of this.actions) {
      const eff = this.effectiveCombo(a, ctx.appId);
      if (eff === null) continue;
      if (!candidates.has(eff)) continue;
      if (!this.scopeReachable(a.scope, ctx)) continue;
      matches.push({ action: a, combo: eff });
    }
    if (matches.length === 0) return { actionId: null, fired: false };
    matches.sort((x, y) => scopeRank(y.action.scope) - scopeRank(x.action.scope));
    const winner = matches[0]!.action;
    const handler = this.handlers.get(winner.id);
    if (!handler) {
      // No shell-side handler — caller decides what to do. For app-scope
      // actions this is the expected branch (handlers live inside the app
      // iframe and the shell bounces back via postMessage). For OS-scope
      // actions during Phase 1+2 (before handlers are bound) this is a
      // transient state that disappears once Phase 3 wires defaults.
      log.debug('match no-handler', combo, '→', winner.id);
      return { actionId: winner.id, fired: false };
    }
    log.debug('fire', combo, '→', winner.id, '(source=', ctx.source, ')');
    try {
      const res = handler(ctx);
      if (res && typeof (res as Promise<unknown>).then === 'function') {
        (res as Promise<boolean | void>).catch((err) => {
          log.warn(`handler ${winner.id} rejected:`, err);
        });
      }
    } catch (err) {
      log.warn(`handler ${winner.id} threw:`, err);
      return { actionId: winner.id, fired: false };
    }
    return { actionId: winner.id, fired: true };
  }

  /** Combo currently bound to an action, after applying user overrides. */
  private effectiveCombo(a: KeyAction, _focusedAppId: string | null): string | null {
    // app-scope override lives under appOverlays[<appId>][<actionId>]
    if (a.id.startsWith('app.')) {
      const appId = a.id.split('.').slice(1, -1).join('.');  // app.com.foo.bar → com.foo
      const overlay = this.state.appOverlays[appId];
      if (overlay && a.id in overlay) {
        const v = overlay[a.id];
        return v === undefined ? a.defaultCombo : v;
      }
      return a.defaultCombo;
    }
    if (a.id in this.state.bindings) {
      const v = this.state.bindings[a.id];
      return v === undefined ? a.defaultCombo : v;
    }
    return a.defaultCombo;
  }

  /** Whether the current mode + source permit a scope to fire. */
  private scopeReachable(scope: KeyScope, ctx: DispatchCtx): boolean {
    if (scope === 'os-always')   return true;
    if (scope === 'os-modifier') return true;
    if (scope === 'os-nav')      return this.mode === 'nav';
    if (scope === 'app')         return ctx.source === 'iframe' && this.mode === 'app';
    return false;
  }

  private notifyClaims(): void {
    if (this.claimListeners.size === 0) return;
    const perApp = new Map<string, string[]>();
    // Build per-app overlays for every app we have bindings for.
    for (const appId of Object.keys(this.state.appOverlays)) {
      perApp.set(appId, this.getClaimListForApp(appId));
    }
    const payload = { os: this.getClaimListForApp(null), perApp };
    for (const cb of this.claimListeners) {
      try { cb(payload); } catch (err) { log.warn('claim listener threw:', err); }
    }
  }
}

function scopeRank(s: KeyScope): number {
  if (s === 'os-always')   return 4;
  if (s === 'os-modifier') return 3;
  if (s === 'os-nav')      return 2;
  if (s === 'app')         return 1;
  return 0;
}

declare global { interface Window { auraKeyDispatcher?: KeyDispatcher } }

/**
 * Pinned on `window` so the various `<script>` blocks in OSLayout and
 * index.astro all share the same instance (Astro bundles each script as a
 * separate ES module; without the window pin they'd each get their own).
 */
export function getKeyDispatcher(): KeyDispatcher {
  if (typeof window === 'undefined') {
    throw new Error('KeyDispatcher is browser-only');
  }
  if (!window.auraKeyDispatcher) {
    window.auraKeyDispatcher = new KeyDispatcher();
  }
  return window.auraKeyDispatcher;
}
