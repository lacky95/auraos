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
 * Every mutation funnels through `pushState()`, which posts the FULL workspace
 * list to the KV endpoint. That endpoint stores whatever JSON it's given — the
 * invariants (id uniqueness, activeWorkspaceId existence, never deleting the
 * last workspace) are enforced here, on the client.
 *
 * Members are kept as activityIds (or instanceIds for activityMode='none'
 * apps). The shell's viewId already equals `activityId ?? instanceId`, so
 * matching `members.includes(view.viewId)` is the natural filter.
 */

/** Per-window geometry persisted for `stack` layout. */
export interface SavedRect { x: number; y: number; w: number; h: number; z: number }

/**
 * Per-workspace layout state. Empty / partial by design — different
 * layout strategies use different fields:
 *   • `stack`        → `rects[viewId]` (drag + resize persistence)
 *   • `fullscreen`   → `focusedViewId` (which view fills the screen)
 *   • tiling / etc.  → ordering comes from `members`, no extra state
 */
export interface LayoutState {
  rects?:         Record<string, SavedRect>;
  focusedViewId?: string;
}

export interface Workspace {
  id:        string;
  name:      string;
  layoutId:  string;
  members:   string[];
  layoutState?: LayoutState;
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
const listeners = new Set<Listener>();

function cloneLayoutState(ls: LayoutState | undefined): LayoutState | undefined {
  if (!ls) return undefined;
  const out: LayoutState = {};
  if (ls.rects) {
    const r: Record<string, SavedRect> = {};
    for (const [k, v] of Object.entries(ls.rects)) r[k] = { ...v };
    out.rects = r;
  }
  if (ls.focusedViewId) out.focusedViewId = ls.focusedViewId;
  return out;
}
function clone(s: WorkspaceState): WorkspaceState {
  return {
    activeWorkspaceId: s.activeWorkspaceId,
    workspaces: s.workspaces.map((w) => ({
      id: w.id, name: w.name, layoutId: w.layoutId,
      members: [...w.members],
      ...(w.layoutState ? { layoutState: cloneLayoutState(w.layoutState)! } : {}),
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

function notify(state: WorkspaceState): void {
  for (const cb of listeners) {
    try { cb(state); } catch (err) { console.warn('[workspaceClient] listener threw', err); }
  }
}

/** Seed the cache from SSR (avoids a fetch on first read). */
export function hydrate(state: WorkspaceState): void {
  cached = clone(state);
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

export async function refresh(): Promise<WorkspaceState> {
  const res = await fetchWithBootRetry(ENDPOINT);
  if (!res.ok) throw new Error(`[workspaceClient] GET → HTTP ${res.status}`);
  // KV API wraps values: `{ value: WorkspaceState, updatedAt: number }`.
  // Unwrap before notifying subscribers; they speak `WorkspaceState`.
  const body = await res.json() as { value: WorkspaceState };
  cached = clone(body.value);
  notify(cached);
  return cached;
}

/**
 * Push the full workspace list + active id to the provider. Local cache is
 * updated optimistically; on server error the cache reverts via the SSE
 * reconcile path (`workspaces:changed` carries the server's view).
 */
async function pushState(next: WorkspaceState): Promise<void> {
  const previous = cached;
  cached = clone(next);
  notify(cached);

  try {
    const res = await fetchWithBootRetry(ENDPOINT, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      // KV PUT body shape is `{ value: <payload> }` — wrap the
      // WorkspaceState so the server doesn't have to special-case us.
      body:    JSON.stringify({ value: next }),
    });
    if (!res.ok) {
      console.warn('[workspaceClient] PUT failed:', await res.text());
      if (previous) { cached = previous; notify(previous); }
    }
  } catch (err) {
    console.error('[workspaceClient] PUT errored:', err);
    if (previous) { cached = previous; notify(previous); }
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
  await pushState({ ...clone(s), activeWorkspaceId: id });
}

/** Replace one workspace's fields. The workspace must already exist. */
export async function patchWorkspace(id: string, patch: Partial<Omit<Workspace, 'id'>>): Promise<void> {
  const s = clone(require_());
  const idx = s.workspaces.findIndex((w) => w.id === id);
  if (idx < 0) return;
  s.workspaces[idx] = { ...s.workspaces[idx]!, ...patch };
  await pushState(s);
}

export async function createWorkspace(name?: string): Promise<Workspace> {
  const s = clone(require_());
  // Pick the next free `ws-<n>`. Numbers can have gaps if the user deleted
  // workspaces — we always pick (max + 1) so renumbering never disturbs an
  // existing id (members reference them and we don't want broken pointers).
  let maxN = 0;
  for (const w of s.workspaces) {
    const m = /^ws-(\d+)$/.exec(w.id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  const id = `ws-${maxN + 1}`;
  const ws: Workspace = {
    id,
    name: name ?? `WS ${maxN + 1}`,
    layoutId: 'tiling',
    members: [],
  };
  s.workspaces.push(ws);
  s.activeWorkspaceId = id;
  await pushState(s);
  return ws;
}

/** Remove a workspace. Its members migrate to the active fallback workspace. */
export async function deleteWorkspace(id: string): Promise<void> {
  const s = clone(require_());
  if (s.workspaces.length <= 1) return;  // never delete the last one
  const victim = s.workspaces.find((w) => w.id === id);
  if (!victim) return;
  const fallback = s.workspaces.find((w) => w.id !== id);
  if (!fallback) return;
  fallback.members = [...fallback.members, ...victim.members];
  s.workspaces = s.workspaces.filter((w) => w.id !== id);
  if (s.activeWorkspaceId === id) s.activeWorkspaceId = fallback.id;
  await pushState(s);
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
  const s = clone(require_());
  const from = s.workspaces.findIndex((w) => w.id === id);
  if (from < 0) return;
  const to = Math.min(Math.max(0, toIndex), s.workspaces.length - 1);
  if (to === from) return;
  const [ws] = s.workspaces.splice(from, 1);
  s.workspaces.splice(to, 0, ws!);
  await pushState(s);
}

/**
 * Move a viewId so it lives ONLY in the currently-active workspace.
 * Same exclusivity contract as `addMemberToWorkspace`: a view belongs to
 * exactly one workspace, never two. Defends against racy paths where the
 * shell-initiated launch already pinned the view to one workspace and the
 * SSE `activity:opened` listener tries to add it to the active one too.
 */
export async function addMemberToActive(viewId: string): Promise<void> {
  const s = clone(require_());
  return addMemberToWorkspaceInState(s, s.activeWorkspaceId, viewId);
}

/** Shared core for both `addMemberToActive` and `addMemberToWorkspace`. */
async function addMemberToWorkspaceInState(s: WorkspaceState, wsId: string, viewId: string): Promise<void> {
  const target = s.workspaces.find((w) => w.id === wsId);
  if (!target) return;
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
  if (mutated) await pushState(s);
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
  const s = clone(require_());
  return addMemberToWorkspaceInState(s, wsId, viewId);
}

/** Remove a viewId from every workspace's members (strict mode: at most one). */
export async function removeMember(viewId: string): Promise<void> {
  const s = clone(require_());
  let touched = false;
  for (const w of s.workspaces) {
    const next = w.members.filter((m) => m !== viewId);
    if (next.length !== w.members.length) { w.members = next; touched = true; }
  }
  if (touched) await pushState(s);
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
