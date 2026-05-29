/**
 * Browser-side client for viewport profiles (device localStorage).
 *
 * Mirrors lib/workspaceClient: a module-scoped optimistic cache + a subscriber
 * list + a debounced write. The ACTIVE profile's values are applied to the
 * live shell through the `window.auraSet*` primitives StatusBar exposes (the
 * body transform + the per-iframe `--aura-iframe-scale`).
 *
 * Source of truth is `localStorage[STORAGE_KEY]` — viewport is a per-device
 * setting (your monitor, your zoom preferences), not user-account state, so
 * it lives in the browser. Convergence across surfaces in the SAME tab — the
 * status-bar zoom buttons and the React settings dialog — happens through the
 * shared module-scoped cache + listener list. Cross-tab sync rides the native
 * `storage` event.
 */
import {
  type ViewportState,
  type ViewportProfile,
  type ViewportMargins,
  DEFAULT_VIEWPORT_STATE,
  normalizeState,
  resolveActiveProfile,
  cloneState,
  clampZoom,
  clampMargins,
} from './viewport';

const STORAGE_KEY = 'aura.os.viewport';

declare global {
  interface Window {
    auraSetZoom?:      (z: number) => void;
    auraSetShellZoom?: (z: number) => void;
    auraSetAppZoom?:   (z: number) => void;
    auraSetMargins?:   (m: Partial<ViewportMargins>) => void;
  }
}

type Listener = (state: ViewportState) => void;

let cached: ViewportState | null = null;
const listeners = new Set<Listener>();
let syncWired = false;

// Mutations patch `cached` in place (cheap, ergonomic) but subscribers need a
// fresh top-level reference each time so React's `setState` doesn't bail on
// the `Object.is` check. Clone once per notify and hand the same snapshot to
// every listener.
function notify(): void {
  if (!cached) return;
  const snapshot = cloneState(cached);
  for (const cb of listeners) {
    try { cb(snapshot); } catch (err) { console.warn('[viewportClient] listener threw', err); }
  }
}

/** Subscribe to state changes. Replays the current state immediately. */
export function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  if (cached) cb(cloneState(cached));
  return () => listeners.delete(cb);
}

export function getCached(): ViewportState | null {
  return cached ? cloneState(cached) : null;
}

/**
 * Read the device-wide auto-reload flag. Reads localStorage FRESH rather than
 * trusting this module's `cached`: the dev reload guard (lib/devReload) calls
 * this from a different module graph than the React dialog that writes it, and
 * no `storage` event fires in the same tab — so the cache could be stale. The
 * write side (`setAutoReload`) persists synchronously to make this read see it.
 */
export function isAutoReloadEnabled(): boolean {
  return (readStorage() ?? cached ?? DEFAULT_VIEWPORT_STATE).autoReload;
}

export function activeProfile(): ViewportProfile | null {
  return cached ? resolveActiveProfile(cached) : null;
}

/** Seed the cache from an arbitrary JSON blob. Mostly here for tests. */
export function hydrate(raw: unknown): void {
  cached = normalizeState(raw);
}

function readStorage(): ViewportState | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeState(JSON.parse(raw));
  } catch (err) {
    console.warn('[viewportClient] localStorage read failed', err);
    return null;
  }
}

function writeStorage(state: ViewportState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[viewportClient] localStorage write failed', err);
  }
}

/** Apply the active profile's viewport to the live shell. */
export function applyActiveToDom(): void {
  if (!cached) return;
  const p = resolveActiveProfile(cached);
  try {
    window.auraSetZoom?.(p.zoom);
    window.auraSetShellZoom?.(p.shellZoom);
    window.auraSetAppZoom?.(p.appZoom);
    window.auraSetMargins?.({ ...p.margins });
  } catch (err) {
    console.warn('[viewportClient] applyActiveToDom failed', err);
  }
}

// ── Theme push (read-modify-write to os/theme) ────────────────────────────
// Per-profile themes still drive the OS-wide CSS via `os/theme`: writing
// there fires the existing `kv:changed` → CSS reload → iframe broadcast
// chain in OSLayout, so the shell + every app picks up the new palette
// without us re-implementing the apply path.
let lastPushedLight: string | null = null;
let lastPushedDark:  string | null = null;
async function pushThemeFromActive(): Promise<void> {
  if (!cached || typeof fetch === 'undefined') return;
  const p = resolveActiveProfile(cached);
  if (p.themeIdLight === lastPushedLight && p.themeIdDark === lastPushedDark) return;
  lastPushedLight = p.themeIdLight;
  lastPushedDark  = p.themeIdDark;
  try {
    const cur = await fetch('/api/kv/os/theme');
    const prev = cur.ok
      ? ((await cur.json()) as { value?: Record<string, unknown> }).value ?? {}
      : {};
    const next = { ...prev, themeIdLight: p.themeIdLight, themeIdDark: p.themeIdDark };
    const res = await fetch('/api/kv/os/theme', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ value: next }),
    });
    if (!res.ok) console.warn('[viewportClient] theme PUT not ok', res.status, await res.text());
  } catch (err) {
    console.warn('[viewportClient] theme PUT failed', err);
  }
}

/**
 * Load state from localStorage (or fall back to defaults), notify, and return.
 * `refresh` is kept async to match the prior contract for call sites that
 * `await` it; the read itself is synchronous.
 */
export async function refresh(): Promise<ViewportState> {
  cached = readStorage() ?? cloneState(DEFAULT_VIEWPORT_STATE);
  notify();
  return cached;
}

/**
 * Apply the active profile to the DOM and wire cross-tab sync via the native
 * `storage` event. Idempotent — safe to call from both StatusBar and the
 * dialog.
 */
export function init(): void {
  applyActiveToDom();
  if (syncWired) return;
  syncWired = true;
  if (typeof window === 'undefined') return;
  window.addEventListener('storage', (ev: StorageEvent) => {
    if (ev.key !== STORAGE_KEY || ev.storageArea !== localStorage) return;
    if (ev.newValue == null) {
      cached = cloneState(DEFAULT_VIEWPORT_STATE);
    } else {
      try { cached = normalizeState(JSON.parse(ev.newValue)); }
      catch { cached = cloneState(DEFAULT_VIEWPORT_STATE); }
    }
    notify();
    applyActiveToDom();
  });
}

// ── Persistence (debounced) ───────────────────────────────────────────────
let writeTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleWrite(delayMs = 250): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => { writeTimer = null; pushState(); }, delayMs);
}
function pushState(): void {
  if (!cached) return;
  writeStorage(cached);
}

function ensure(): ViewportState {
  if (!cached) cached = cloneState(DEFAULT_VIEWPORT_STATE);
  return cached;
}

// ── Mutations (optimistic apply + notify + debounced persist) ─────────────

/** Patch the active profile's viewport values. Applies + persists. */
export function patchActive(
  patch: Partial<Pick<ViewportProfile, 'zoom' | 'shellZoom' | 'appZoom' | 'themeIdLight' | 'themeIdDark'>> & { margins?: Partial<ViewportMargins> },
): void {
  const p = resolveActiveProfile(ensure());
  if (patch.zoom         !== undefined) p.zoom         = clampZoom(patch.zoom);
  if (patch.shellZoom    !== undefined) p.shellZoom    = clampZoom(patch.shellZoom);
  if (patch.appZoom      !== undefined) p.appZoom      = clampZoom(patch.appZoom);
  if (patch.themeIdLight !== undefined) p.themeIdLight = patch.themeIdLight;
  if (patch.themeIdDark  !== undefined) p.themeIdDark  = patch.themeIdDark;
  if (patch.margins)  p.margins = { ...p.margins, ...clampMargins(patch.margins) };
  applyActiveToDom();
  notify();
  scheduleWrite();
  if (patch.themeIdLight !== undefined || patch.themeIdDark !== undefined) {
    void pushThemeFromActive();
  }
}

/**
 * Toggle the dev-only auto-reload-on-source-change flag (device-wide). Unlike
 * the profile mutations this persists IMMEDIATELY (not via the debounced
 * scheduleWrite) so the reload guard, which reads localStorage fresh, sees the
 * new value the instant the user flips it — even before the debounce window.
 */
export function setAutoReload(enabled: boolean): void {
  const s = ensure();
  if (s.autoReload === enabled) return;
  s.autoReload = enabled;
  notify();
  pushState();
}

/** Switch the active profile and apply its viewport (+ themes). */
export function setActive(id: string): void {
  const s = ensure();
  if (s.activeProfileId === id) return;
  if (!s.profiles.some((p) => p.id === id)) return;
  s.activeProfileId = id;
  applyActiveToDom();
  notify();
  scheduleWrite();
  void pushThemeFromActive();
}

/**
 * Add a new profile (a copy of the current active one — duplicate-and-tweak)
 * and switch to it. Returns the created profile.
 */
export function addProfile(name?: string): ViewportProfile {
  const s = ensure();
  const base = resolveActiveProfile(s);
  const ids = new Set(s.profiles.map((p) => p.id));
  let n = s.profiles.length + 1;
  let id = `profile-${n}`;
  while (ids.has(id)) { n++; id = `profile-${n}`; }
  const profile: ViewportProfile = {
    id,
    name:         name ?? `Profile ${n}`,
    zoom:         base.zoom,
    shellZoom:    base.shellZoom,
    appZoom:      base.appZoom,
    margins:      { ...base.margins },
    themeIdLight: base.themeIdLight,
    themeIdDark:  base.themeIdDark,
  };
  s.profiles.push(profile);
  s.activeProfileId = id;
  applyActiveToDom();
  notify();
  scheduleWrite();
  // New profile inherits the source's themes, so no theme change to push.
  return profile;
}

export function renameProfile(id: string, name: string): void {
  const s = ensure();
  const p = s.profiles.find((x) => x.id === id);
  if (!p) return;
  p.name = name;
  notify();
  scheduleWrite();
}

/** Delete a profile. Never removes the last one; reselects if it was active. */
export function deleteProfile(id: string): void {
  const s = ensure();
  if (s.profiles.length <= 1) return;
  const idx = s.profiles.findIndex((p) => p.id === id);
  if (idx < 0) return;
  s.profiles.splice(idx, 1);
  if (s.activeProfileId === id) s.activeProfileId = s.profiles[0]!.id;
  applyActiveToDom();
  notify();
  scheduleWrite();
}
