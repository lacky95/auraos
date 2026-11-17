/**
 * Browser-side client for the workspaces content provider.
 *
 * Wraps the `/api/data/com.aura.settings/workspaces` GET/PUT pair with:
 *   • Local optimistic state — UI updates immediately on user action
 *     instead of waiting for a Settings round-trip.
 *   • A subscriber list — anything that cares about the workspace state
 *     (the desktop, the status-bar pills, the Settings page) registers a
 *     callback and gets re-notified whenever the state moves.
 *   • Convenience helpers (createWorkspace, deleteWorkspace, moveWorkspace,
 *     setActive, patchWorkspace) that compose the above primitives.
 *
 * Every mutation funnels through `commit()`, which posts the FULL workspace
 * list to the KV endpoint. That endpoint stores whatever JSON it's given — the
 * invariants (id uniqueness, activeWorkspaceId existence, never deleting the
 * last workspace) are enforced here, on the client.
 *
 * Writes are conditional (`ifUpdatedAt` = the version the cache came from):
 * a cache that fell behind — a tab or phone WebView resumed after hours —
 * gets 409 + the current state, and the mutation is replayed on that instead
 * of rolling every newer change back (2026-11-17: a day-old tab replaced 8
 * workspaces with 3).
 *
 * Members are kept as activityIds (or instanceIds for activityMode='none'
 * apps). The shell's viewId already equals `activityId ?? instanceId`, so
 * matching `members.includes(view.viewId)` is the natural filter.
 */

/** Per-window geometry persisted for `stack` layout. `snap` = docked into a
 *  zone of the workspace's snap grid (lib/layout/strategies/freeWindow). */
export interface SavedRect {
  x: number; y: number; w: number; h: number; z: number;
  snap?: { zone: string; restore: { w: number; h: number } };
}

/**
 * Per-workspace layout state. Empty / partial by design — different
 * layout strategies use different fields:
 *   • `stack`        → `rects[viewId]` (drag + resize persistence),
 *                      `snapGrid` (shared dock split fractions)
 *   • `fullscreen`   → `focusedViewId` (which view fills the screen)
 *   • any layout with `minimize: 'hide'` → `minimized` (hidden viewIds)
 *   • tiling / etc.  → ordering comes from `members`, no extra state
 * Open-ended: a layout strategy may keep its own keys here (JSON values).
 */
export interface LayoutState {
  rects?:         Record<string, SavedRect>;
  focusedViewId?: string;
  minimized?:     string[];
  [key: string]:  unknown;
}

/** Shell-owned state of one activity, kept across reloads and OS restarts
 *  (lib/desktopSession.ts remaps it with the activity's id). */
export interface ActivityViewState {
  /** The user's label for the activity (rename). */
  name?:      string;
  /** Maximized in place: 'area' = the activities area, 'full' = over the bars. */
  maximized?: 'area' | 'full';
}

export interface Workspace {
  id:        string;
  name:      string;
  layoutId:  string;
  members:   string[];
  layoutState?: LayoutState;
  /** viewId → shell state of that activity (name, maximized). */
  activities?: Record<string, ActivityViewState>;
}

export interface WorkspaceState {
  workspaces:        Workspace[];
  activeWorkspaceId: string;
}

const ENDPOINT = '/api/kv/os/workspaces';

/**
 * Boot-race retry: the shell middleware spins up Valkey + AppManager on the
 * first request, so a very fast browser can land before Valkey is ready.
 * That window is now sub-second (no Settings autoStart in the path), but
 * we keep the retry as defence-in-depth.
 */
async function fetchWithBootRetry(
  url: string,
  init?: RequestInit,
  { attempts = 5, delayMs = 400 } = {},
): Promise<Response> {
  let lastRes: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    lastRes = await fetch(url, init);
    if (lastRes.status !== 404) return lastRes;
    // 404 on KV means the key is absent OR the singleton isn't ready yet.
    // Inspect the body — only retry on the "missing-value" form for
    // workspaces (we expect bootstrapKv to have written it).
    const body = await lastRes.clone().text().catch(() => '');
    if (!body.includes('No value at os:workspaces')) return lastRes;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return lastRes!;
}

type Listener = (state: WorkspaceState) => void;

let cached: WorkspaceState | null = null;
/** `updatedAt` of the server version `cached` is based on (null: unknown). */
let baseUpdatedAt: number | null = null;
const listeners = new Set<Listener>();

/**
 * Local-write bookkeeping for refresh(). `writeGen` bumps on every PUT and
 * `writesInFlight` counts unanswered ones. A GET that overlaps a local
 * write (or runs while a debounced patch is still queued) returns a state
 * OLDER than the cache — applying it rolls fresh edits back until the next
 * echo, which is how a just-dropped free window jumped to its old spot.
 */
let writeGen = 0;
let writesInFlight = 0;

/** Deep copy of every key — strategies keep their own (JSON) fields here,
 *  and a field dropped by the clone would be lost on the next PUT. */
function cloneLayoutState(ls: LayoutState | undefined): LayoutState | undefined {
  if (!ls) return undefined;
  return JSON.parse(JSON.stringify(ls)) as LayoutState;
}
function clone(s: WorkspaceState): WorkspaceState {
  return {
    activeWorkspaceId: s.activeWorkspaceId,
    workspaces: s.workspaces.map((w) => ({
      id: w.id, name: w.name, layoutId: w.layoutId,
      members: [...w.members],
      ...(w.layoutState ? { layoutState: cloneLayoutState(w.layoutState)! } : {}),
      ...(w.activities ? { activities: JSON.parse(JSON.stringify(w.activities)) as Record<string, ActivityViewState> } : {}),
    })),
  };
}

/**
 * Coalesced write helper — multiple rapid calls within `delayMs` collapse
 * into a single PUT to the workspace endpoint. Drag/resize call this ~60
 * times a second; debouncing the network write keeps Valkey from melting.
 */
const pendingPatch = new Map<string, { patch: Partial<Omit<Workspace, 'id'>>; timer: ReturnType<typeof setTimeout> }>();
export function patchWorkspaceDebounced(id: string, patch: Partial<Omit<Workspace, 'id'>>, delayMs = 250): void {
  const existing = pendingPatch.get(id);
  const merged = existing ? { ...existing.patch, ...patch } : patch;
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingPatch.delete(id);
    void patchWorkspace(id, merged);
  }, delayMs);
  pendingPatch.set(id, { patch: merged, timer });
  // Apply optimistically locally so UI subscribers see the new state at once.
  // (We don't want the debounce to delay the visual.)
  if (cached) {
    const s = clone(cached);
    const idx = s.workspaces.findIndex((w) => w.id === id);
    if (idx >= 0) {
      s.workspaces[idx] = { ...s.workspaces[idx]!, ...merged };
      cached = s;
      notify(cached);
    }
  }
}

/**
 * Send every debounced patch NOW — before the page unloads or the OS goes
 * down for a planned restart, so the last drag / rename is not lost.
 */
export async function flushPending(): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const [id, p] of pendingPatch) {
    clearTimeout(p.timer);
    pendingPatch.delete(id);
    jobs.push(patchWorkspace(id, p.patch));
  }
  await Promise.all(jobs);
}

/** Like `flushPending`, for `beforeunload` — a fetch with keepalive survives
 *  the page going away, a plain one may not. */
export function flushPendingOnUnload(): void {
  if (!pendingPatch.size || !cached) return;
  const s = clone(cached);
  for (const [id, p] of pendingPatch) {
    clearTimeout(p.timer);
    const idx = s.workspaces.findIndex((w) => w.id === id);
    if (idx >= 0) s.workspaces[idx] = { ...s.workspaces[idx]!, ...p.patch };
  }
  pendingPatch.clear();
  try {
    // Conditional like every write: a stale page loses its last patch
    // rather than overwriting newer state.
    void fetch(ENDPOINT, {
      method: 'PUT', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(putBody(s)),
    });
  } catch { /* page is going away */ }
}

function notify(state: WorkspaceState): void {
  for (const cb of listeners) {
    try { cb(state); } catch (err) { console.warn('[workspaceClient] listener threw', err); }
  }
}

/** Seed the cache from SSR (avoids a fetch on first read). `updatedAt` is
 *  the version SSR read; without it the first write is unconditional. */
export function hydrate(state: WorkspaceState, updatedAt?: number | null): void {
  cached = clone(state);
  baseUpdatedAt = typeof updatedAt === 'number' ? updatedAt : null;
}

/** Subscribe to state changes. Returns an unsubscribe function. */
export function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  if (cached) cb(cached);  // immediate replay so subscribers start in sync
  return () => listeners.delete(cb);
}

export function getCached(): WorkspaceState | null {
  return cached ? clone(cached) : null;
}

/**
 * The cached state itself, without the deep copy getCached() makes. For hot
 * read-only paths (every desktop render, a layout's per-activity reads): the
 * copy cost grows with every workspace's layoutState. Never mutate the result.
 */
export function peekCached(): Readonly<WorkspaceState> | null {
  return cached;
}

export async function refresh(): Promise<WorkspaceState> {
  const gen = writeGen;
  const res = await fetchWithBootRetry(ENDPOINT);
  if (!res.ok) throw new Error(`[workspaceClient] GET → HTTP ${res.status}`);
  // KV API wraps values: `{ value: WorkspaceState, updatedAt: number }`.
  // Unwrap before notifying subscribers; they speak `WorkspaceState`.
  const body = await res.json() as { value: WorkspaceState; updatedAt?: number };
  // Local edits newer than this response: keep them. Their own PUT fires
  // `workspaces:changed`, whose refresh brings the converged state.
  if (cached && (gen !== writeGen || writesInFlight > 0 || pendingPatch.size > 0)) {
    return clone(cached);
  }
  cached = clone(body.value);
  baseUpdatedAt = typeof body.updatedAt === 'number' ? body.updatedAt : null;
  notify(cached);
  return cached;
}

/** KV PUT body: the state, conditional on the version the cache is based on. */
function putBody(value: WorkspaceState): { value: WorkspaceState; ifUpdatedAt?: number } {
  return baseUpdatedAt === null ? { value } : { value, ifUpdatedAt: baseUpdatedAt };
}

/** A mutation: gets a private copy of the state, returns the next state, or
 *  null when there is nothing to change. Pure — it may run again on a newer
 *  state when the server says the cache was stale. */
type Mutation = (s: WorkspaceState) => WorkspaceState | null;

const MAX_REBASES = 3;

/**
 * Apply `mutate` to the cache (optimistic: subscribers see it at once) and
 * write the result. A 409 means another device or the server changed the
 * state since this cache was loaded: adopt the server's state, replay
 * `mutate` on it, and try again. On any other failure the cache reverts via
 * the SSE reconcile path (`workspaces:changed` carries the server's view).
 */
async function commit(mutate: Mutation): Promise<void> {
  let next = mutate(clone(require_()));
  if (!next) return;
  const previous = cached;
  cached = clone(next);
  notify(cached);

  writeGen++;
  writesInFlight++;
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchWithBootRetry(ENDPOINT, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        // KV PUT body shape is `{ value: <payload> }` — wrap the
        // WorkspaceState so the server doesn't have to special-case us.
        body:    JSON.stringify(putBody(next)),
      });
      if (res.ok) {
        const stored = await res.json().catch(() => null) as { updatedAt?: number } | null;
        if (typeof stored?.updatedAt === 'number') baseUpdatedAt = stored.updatedAt;
        return;
      }
      if (res.status === 409 && attempt < MAX_REBASES) {
        const body = await res.json().catch(() => null) as { current?: { value: WorkspaceState; updatedAt: number } } | null;
        const current = body?.current;
        if (current?.value && Array.isArray(current.value.workspaces)) {
          console.info('[workspaceClient] cache was stale — replaying the change on the current state');
          baseUpdatedAt = current.updatedAt;
          cached = clone(current.value);
          const rebased = mutate(clone(current.value));
          if (!rebased) { notify(cached); return; }
          next = rebased;
          cached = clone(next);
          notify(cached);
          continue;
        }
      }
      console.warn('[workspaceClient] PUT failed:', res.status, await res.text().catch(() => ''));
      if (res.status === 409) { void refresh().catch(() => undefined); return; }
      if (previous) { cached = previous; notify(previous); }
      return;
    }
  } catch (err) {
    console.error('[workspaceClient] PUT errored:', err);
    if (previous) { cached = previous; notify(previous); }
  } finally {
    writesInFlight--;
  }
}

function require_(): WorkspaceState {
  if (!cached) throw new Error('[workspaceClient] not hydrated — call hydrate() or refresh() first');
  return cached;
}

// -------- public mutation API --------

export function activeWorkspace(): Workspace {
  const s = require_();
  const w = s.workspaces.find((x) => x.id === s.activeWorkspaceId);
  if (!w) throw new Error(`[workspaceClient] activeWorkspaceId '${s.activeWorkspaceId}' has no matching workspace`);
  return w;
}

export async function setActive(id: string): Promise<void> {
  const s = require_();
  if (s.activeWorkspaceId === id) return;
  if (!s.workspaces.some((w) => w.id === id)) {
    console.warn(`[workspaceClient] setActive('${id}'): unknown workspace`);
    return;
  }
  await commit((s) => {
    if (s.activeWorkspaceId === id || !s.workspaces.some((w) => w.id === id)) return null;
    return { ...s, activeWorkspaceId: id };
  });
}

/** Replace one workspace's fields. The workspace must already exist. */
export async function patchWorkspace(id: string, patch: Partial<Omit<Workspace, 'id'>>): Promise<void> {
  await commit((s) => {
    const idx = s.workspaces.findIndex((w) => w.id === id);
    if (idx < 0) return null;
    s.workspaces[idx] = { ...s.workspaces[idx]!, ...patch };
    return s;
  });
}

export async function createWorkspace(name?: string): Promise<Workspace> {
  let ws!: Workspace;
  await commit((s) => {
    // Pick the next free `ws-<n>`. Numbers can have gaps if the user deleted
    // workspaces — we always pick (max + 1) so renumbering never disturbs an
    // existing id (members reference them and we don't want broken pointers).
    // The default NAME follows the pill number instead (count + 1), so it stays
    // in step with `compactWorkspaces()` renumbering.
    let maxN = 0;
    for (const w of s.workspaces) {
      const m = /^ws-(\d+)$/.exec(w.id);
      if (m) maxN = Math.max(maxN, Number(m[1]));
    }
    const id = `ws-${maxN + 1}`;
    ws = {
      id,
      name: name ?? `WS ${s.workspaces.length + 1}`,
      layoutId: 'tiling',
      members: [],
    };
    s.workspaces.push(ws);
    s.activeWorkspaceId = id;
    return s;
  });
  return ws;
}

/** Remove a workspace. Its members migrate to the active fallback workspace. */
export async function deleteWorkspace(id: string): Promise<void> {
  await commit((s) => {
    if (s.workspaces.length <= 1) return null;  // never delete the last one
    const victim = s.workspaces.find((w) => w.id === id);
    if (!victim) return null;
    const fallback = s.workspaces.find((w) => w.id !== id);
    if (!fallback) return null;
    fallback.members = [...fallback.members, ...victim.members];
    s.workspaces = s.workspaces.filter((w) => w.id !== id);
    if (s.activeWorkspaceId === id) s.activeWorkspaceId = fallback.id;
    return s;
  });
}

/** Default names (`WS <n>`) are renumbered by compaction; anything else is the user's. */
const DEFAULT_NAME_RE = /^WS \d+$/;

/**
 * Pure compaction: drop every workspace with no members, then rename each
 * surviving default-named `WS <n>` to `WS <slot>`. Ids, members, layout and
 * custom names are untouched. Never leaves zero workspaces — if all are empty
 * the active one survives. An empty active workspace is dropped like any
 * other; the nearest survivor before it (else the first) becomes active.
 */
export function compactState(state: WorkspaceState): WorkspaceState {
  const s = clone(state);
  let kept = s.workspaces.filter((w) => w.members.length > 0);
  if (kept.length === 0) {
    const active = s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? s.workspaces[0];
    kept = active ? [active] : [];
  }
  kept.forEach((w, i) => {
    if (DEFAULT_NAME_RE.test(w.name)) w.name = `WS ${i + 1}`;
  });

  let activeId = s.activeWorkspaceId;
  if (!kept.some((w) => w.id === activeId)) {
    const keptIds = new Set(kept.map((w) => w.id));
    const activeIdx = s.workspaces.findIndex((w) => w.id === activeId);
    const before = s.workspaces.slice(0, Math.max(0, activeIdx)).reverse().find((w) => keptIds.has(w.id));
    activeId = (before ?? kept[0])?.id ?? activeId;
  }
  return { ...s, workspaces: kept, activeWorkspaceId: activeId };
}

/** True when `compactWorkspaces()` would change anything. */
export function canCompact(state: WorkspaceState): boolean {
  // Compaction only ever drops workspaces, renames them, or moves the active
  // id — comparing those is enough (and immune to key order in the state).
  const next = compactState(state);
  return next.activeWorkspaceId !== state.activeWorkspaceId
    || next.workspaces.length !== state.workspaces.length
    || next.workspaces.some((w, i) => w.name !== state.workspaces[i]!.name);
}

/** Remove empty workspaces and renumber default `WS <n>` names, in one write. */
export async function compactWorkspaces(): Promise<void> {
  await commit((s) => (canCompact(s) ? compactState(s) : null));
}

/**
 * Reposition a workspace to a 0-based index in the list. Splice-move
 * semantics: the workspace is pulled out and reinserted, so everything from
 * `toIndex` onwards shifts one slot up (moving #5 to slot 2 gives
 * `1, 5, 2, 3, 4`).
 *
 * The displayed pill number is purely `index + 1` — ids stay put, and every
 * pointer into workspace state (members, activeWorkspaceId, layoutState,
 * launch pins) keys off the id. So this is a pure presentation reorder and
 * `activeWorkspaceId` is deliberately left alone: whichever workspace was
 * active stays active, it just renumbers.
 */
export async function moveWorkspace(id: string, toIndex: number): Promise<void> {
  await commit((s) => {
    const from = s.workspaces.findIndex((w) => w.id === id);
    if (from < 0) return null;
    const to = Math.min(Math.max(0, toIndex), s.workspaces.length - 1);
    if (to === from) return null;
    const [ws] = s.workspaces.splice(from, 1);
    s.workspaces.splice(to, 0, ws!);
    return s;
  });
}

/**
 * Move a viewId so it lives ONLY in the currently-active workspace.
 * Same exclusivity contract as `addMemberToWorkspace`: a view belongs to
 * exactly one workspace, never two. Defends against racy paths where the
 * shell-initiated launch already pinned the view to one workspace and the
 * SSE `activity:opened` listener tries to add it to the active one too.
 */
export async function addMemberToActive(viewId: string): Promise<void> {
  // The active workspace at the time of the call — a replay must not move
  // the view to whatever another device made active meanwhile.
  const wsId = require_().activeWorkspaceId;
  await commit((s) => addMemberInState(s, wsId, viewId));
}

/** Shared core for both `addMemberToActive` and `addMemberToWorkspace`. */
function addMemberInState(s: WorkspaceState, wsId: string, viewId: string): WorkspaceState | null {
  const target = s.workspaces.find((w) => w.id === wsId);
  if (!target) return null;
  let mutated = false;
  for (const w of s.workspaces) {
    if (w.id === wsId) continue;
    const before = w.members.length;
    w.members = w.members.filter((m) => m !== viewId);
    if (w.members.length !== before) mutated = true;
  }
  if (!target.members.includes(viewId)) {
    target.members.push(viewId);
    mutated = true;
  }
  return mutated ? s : null;
}

/**
 * Move a viewId so it lives ONLY in the named workspace's members. Strips it
 * from every other workspace first — a view belongs to exactly one
 * workspace, never two. Used by the launch pipeline to pin a pending view
 * to whichever workspace was active when the user clicked, so a mid-flight
 * workspace switch doesn't end up double-claiming the view on the
 * newly-active workspace via a racy SSE refresh or fallback path.
 */
export async function addMemberToWorkspace(wsId: string, viewId: string): Promise<void> {
  await commit((s) => addMemberInState(s, wsId, viewId));
}

/** Remove a viewId from every workspace's members (strict mode: at most one). */
export async function removeMember(viewId: string): Promise<void> {
  await commit((s) => {
    let touched = false;
    for (const w of s.workspaces) {
      const next = w.members.filter((m) => m !== viewId);
      if (next.length !== w.members.length) { w.members = next; touched = true; }
    }
    return touched ? s : null;
  });
}

/** Find the workspace that owns a given viewId (or null). */
export function findOwner(viewId: string): Workspace | null {
  if (!cached) return null;
  return cached.workspaces.find((w) => w.members.includes(viewId)) ?? null;
}

/**
 * Apply a server-pushed state (from the `workspaces:changed` SSE event).
 * Skips the round-trip — server is the source of truth, we just replicate.
 * Used by index.astro to converge after another tab / Settings page edits.
 */
export function applyServerState(state: WorkspaceState): void {
  cached = clone(state);
  notify(cached);
}

/**
 * A page that sat in the background (hidden tab, suspended phone WebView)
 * can miss `workspaces:changed` events: reload the state when it comes back,
 * before the user acts on an old desktop. Writes are conditional anyway —
 * this just keeps what the user sees current.
 */
function installForegroundRefresh(): void {
  if (typeof document === 'undefined') return;
  const flag = globalThis as { __auraWsForegroundRefresh?: boolean };
  if (flag.__auraWsForegroundRefresh) return;
  flag.__auraWsForegroundRefresh = true;
  let hiddenAt = 0;
  const STALE_AFTER_MS = 5_000;
  const reload = () => { if (cached) void refresh().catch(() => undefined); };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > STALE_AFTER_MS) reload();
  });
  // Restored from the back/forward cache: the whole page is old.
  window.addEventListener('pageshow', (e) => { if (e.persisted) reload(); });
}
installForegroundRefresh();
