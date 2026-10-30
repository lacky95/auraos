/**
 * Rename and prune activity (view) ids across the workspace document — pure,
 * unit-tested (test/workspace-remap.test.ts).
 *
 * Activity ids change when an activity is recreated: an app restart
 * (lib/appRestart.ts) or a desktop restore after an OS restart
 * (lib/desktopSession.ts). Everything that refers to an activity has to follow:
 * workspace `members`, the shell's per-activity state (`activities`: name,
 * maximized) and whatever the layout strategy keeps in `layoutState`
 * (Free Window rects/snap/minimized, fullscreen's focusedViewId, …).
 *
 * The rule for `layoutState` and `activities` is generic so no layout needs its
 * own remap code: any object KEY or string VALUE (at any depth) that equals an
 * activity id is renamed via `idMap`, or dropped when the id is `dead`. Activity
 * ids (`<appId>-<n>` / `<appId>-<n>#a<k>`) don't collide with ordinary
 * strings, which is what makes this safe.
 */

export interface RemapWorkspace {
  id: string;
  members: string[];
  layoutState?: Record<string, unknown>;
  activities?: Record<string, unknown>;
  [k: string]: unknown;
}
export interface RemapState {
  workspaces: RemapWorkspace[];
  activeWorkspaceId: string;
  [k: string]: unknown;
}

const DROP = Symbol('drop');

function remapValue(v: unknown, idMap: Record<string, string>, dead: Set<string>): unknown | typeof DROP {
  if (typeof v === 'string') {
    if (dead.has(v)) return DROP;
    return Object.prototype.hasOwnProperty.call(idMap, v) ? idMap[v] : v;
  }
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const x of v) {
      const r = remapValue(x, idMap, dead);
      if (r === DROP) continue;
      if (typeof r === 'string' && out.includes(r)) continue; // two old ids → one new
      out.push(r);
    }
    return out;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (dead.has(k)) continue;
      const key = Object.prototype.hasOwnProperty.call(idMap, k) ? idMap[k]! : k;
      const r = remapValue(x, idMap, dead);
      if (r === DROP) continue;
      if (key in out && key !== k) continue; // first renamed entry wins
      out[key] = r;
    }
    return out;
  }
  return v;
}

/**
 * Rename ids via `idMap` and drop `dead` ones everywhere in the workspace
 * document. Member order is kept (a renamed activity keeps its slot). Returns
 * a new object; `changed` says whether anything moved.
 */
export function remapWorkspaceIds<T extends RemapState>(
  state: T,
  idMap: Record<string, string>,
  dead: Iterable<string> = [],
): { state: T; changed: boolean } {
  const deadSet = new Set(dead);
  // An id that is renamed is not dead even if listed.
  for (const k of Object.keys(idMap)) deadSet.delete(idMap[k]!);
  const next = structuredClone(state);
  for (const w of next.workspaces) {
    migrateLegacy(w);
    const members: string[] = [];
    for (const m of w.members ?? []) {
      if (deadSet.has(m)) continue;
      const id = Object.prototype.hasOwnProperty.call(idMap, m) ? idMap[m]! : m;
      if (!members.includes(id)) members.push(id);
    }
    w.members = members;
    if (w.layoutState) w.layoutState = remapValue(w.layoutState, idMap, deadSet) as Record<string, unknown>;
    if (w.activities) w.activities = remapValue(w.activities, idMap, deadSet) as Record<string, unknown>;
  }
  return { state: next, changed: JSON.stringify(next) !== JSON.stringify(state) };
}

/**
 * The per-activity state was first stored as `windows`, with maximized
 * 'window' for the activities area — fold it into `activities` / 'area'.
 */
function migrateLegacy(w: RemapWorkspace): void {
  const legacy = (w as { windows?: unknown }).windows;
  if (legacy && typeof legacy === 'object') {
    w.activities = { ...(legacy as Record<string, unknown>), ...(w.activities ?? {}) };
    delete (w as { windows?: unknown }).windows;
  }
  for (const v of Object.values(w.activities ?? {})) {
    const e = v as { maximized?: string } | null;
    if (e && e.maximized === 'window') e.maximized = 'area';
  }
}

/** Every member id of every workspace. */
export function allMembers(state: RemapState): string[] {
  return state.workspaces.flatMap((w) => w.members ?? []);
}
