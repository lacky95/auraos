/**
 * Browser-side client for the workspaces content provider.
 *
 * Wraps the `/api/data/com.aura.settings/workspaces` GET/PUT pair with:
 *   • Local optimistic state — UI updates immediately on user action
 *     instead of waiting for a Settings round-trip.
 *   • A subscriber list — anything that cares about the workspace state
 *     (the desktop, the status-bar pills, the Settings page) registers a
 *     callback and gets re-notified whenever the state moves.
 *   • Convenience helpers (createWorkspace, deleteWorkspace, moveActivity,
 *     setActive, patchWorkspace) that compose the above primitives.
 *
 * The PUT endpoint is the source of truth — every mutation funnels through
 * `pushState()` which posts the FULL workspace list. Server-side validation
 * (id uniqueness, activeWorkspaceId existence, etc.) lives in
 * `apps/com.aura.settings/src/pages/api/data/workspaces.ts` — this file
 * doesn't duplicate it.
 *
 * Members are kept as activityIds (or instanceIds for activityMode='none'
 * apps). The shell's viewId already equals `activityId ?? instanceId`, so
 * matching `members.includes(view.viewId)` is the natural filter.
 */

export interface Workspace {
  id:        string;
  name:      string;
  layoutId:  string;
  members:   string[];
  layoutState?: Record<string, unknown>;
}

export interface WorkspaceState {
  workspaces:        Workspace[];
  activeWorkspaceId: string;
}

const ENDPOINT = '/api/kv/os/workspaces';

/**
 * Boot-race retry: the shell middleware spins up Redis + AppManager on the
 * first request, so a very fast browser can land before Redis is ready.
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

function clone(s: WorkspaceState): WorkspaceState {
  return {
    activeWorkspaceId: s.activeWorkspaceId,
    workspaces: s.workspaces.map((w) => ({
      id: w.id, name: w.name, layoutId: w.layoutId,
      members: [...w.members],
      ...(w.layoutState ? { layoutState: { ...w.layoutState } } : {}),
    })),
  };
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

/** Append a viewId to the active workspace's members (unless already present). */
export async function addMemberToActive(viewId: string): Promise<void> {
  const s = clone(require_());
  const active = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
  if (!active) return;
  if (active.members.includes(viewId)) return;
  active.members.push(viewId);
  await pushState(s);
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
