/**
 * Restart that keeps the user's windows.
 *
 * A plain stop + start drops every activity of the old instance (the shell
 * closes their windows and strips them from the workspaces). This helper
 * snapshots what the user had, restarts, and re-creates it on the new
 * instance:
 *
 *   • every activity, in creation order, with its path / title / history /
 *     breadcrumb (and its stack parent, remapped);
 *   • its workspace membership — same workspace, same position in `members`
 *     (tiling order), same stack-layout rect, same fullscreen focus.
 *
 * Activity ids change (`<inst>#a<n>` counters restart with the instance), so
 * placement is snapshotted before the stop and each new viewId is written
 * into the `os:workspaces` KV document where its old one was. Browsers are told up front
 * (`app:restarting`) so they keep the windows as loading placeholders instead
 * of tearing them down, and `app:restarted` carries the mapping so they swap
 * each window in place.
 */
import { getAppManager, OsEventBus } from '@aura/core';
import { defaultKv } from '@aura/kv-store';

interface RestoredActivity {
  /** Old viewId (activityId, or instanceId for activityMode='none'). */
  from: string;
  /** New viewId. */
  to: string;
  instanceId: string;
  activityId?: string;
  path: string;
  title?: string;
  minimizable?: boolean;
  history?: Array<{ path: string; title?: string }>;
  breadcrumb?: 'os' | 'off';
}

export interface RestartResult {
  appId: string;
  oldInstanceIds: string[];
  instanceId: string;
  restored: RestoredActivity[];
  /** Old activities that could not be re-opened (reason per id). */
  failed: Array<{ from: string; error: string }>;
  workspacesUpdated: boolean;
}

interface WsShape {
  workspaces: Array<{
    id: string;
    members: string[];
    layoutState?: { rects?: Record<string, unknown>; focusedViewId?: string };
    [k: string]: unknown;
  }>;
  activeWorkspaceId: string;
}

const inFlight = new Map<string, Promise<RestartResult>>();

/**
 * Restart `instanceIds` of `appId` (all user-owned instances when omitted)
 * into ONE fresh instance and restore their windows on it. Concurrent calls
 * for the same app share the running restart.
 */
export function restartWithActivities(appId: string, instanceIds?: string[]): Promise<RestartResult> {
  const running = inFlight.get(appId);
  if (running) return running;
  const p = doRestart(appId, instanceIds).finally(() => inFlight.delete(appId));
  inFlight.set(appId, p);
  return p;
}

async function doRestart(appId: string, only?: string[]): Promise<RestartResult> {
  const mgr = getAppManager();
  const manifest = mgr.getManifest(appId);
  if (!manifest) throw new Error(`App not found: ${appId}`);

  const instances = mgr.getInstancesByApp(appId)
    .filter((i) => only ? only.includes(i.instanceId) : !i.inPool);
  const oldInstanceIds = instances.map((i) => i.instanceId);
  const withActivities = manifest.activityMode === 'multi' && manifest.componentType !== 'service';

  // Snapshot BEFORE stop — stop() purges activities.
  const snapshot = withActivities
    ? oldInstanceIds
        .flatMap((id) => mgr.getActivitiesByInstance(id))
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .map((a) => ({ ...a, history: a.history ? [...a.history] : undefined }))
    : [];

  const viewIds = withActivities ? snapshot.map((a) => a.activityId) : oldInstanceIds;
  const before = placementsOf(await readWorkspaces().catch(() => null), viewIds);

  OsEventBus.emit('app:restarting', {
    appId,
    instanceIds: oldInstanceIds,
    viewIds,
  });

  try {
    if (only) await Promise.all(oldInstanceIds.map((id) => mgr.stop(id)));
    else await mgr.stopAll(appId);
    const instanceId = await mgr.start(appId);

    const restored: RestoredActivity[] = [];
    const failed: RestartResult['failed'] = [];
    if (withActivities) {
      const idMap = new Map<string, string>();
      for (const old of snapshot) {
        try {
          const parent = old.stackParentId ? idMap.get(old.stackParentId) : undefined;
          const act = await mgr.openActivity(instanceId, undefined, parent ? { stackParent: parent } : undefined);
          // openActivity lands where the app's onActivityCreate says; put the
          // window back where the user was. `act` is the AppManager's own
          // record, so this is what every later read (and a page reload) sees.
          act.path = old.path;
          if (old.title !== undefined) act.title = old.title;
          if (old.history?.length) act.history = old.history;
          if (old.breadcrumb) act.breadcrumb = old.breadcrumb;
          if (old.metadata && !act.metadata) act.metadata = old.metadata;
          idMap.set(old.activityId, act.activityId);
          restored.push({
            from: old.activityId,
            to: act.activityId,
            instanceId,
            activityId: act.activityId,
            path: act.path,
            ...(act.title !== undefined ? { title: act.title } : {}),
            ...(act.minimizable ? { minimizable: true } : {}),
            ...(act.history?.length ? { history: act.history } : {}),
            ...(act.breadcrumb ? { breadcrumb: act.breadcrumb } : {}),
          });
        } catch (err) {
          failed.push({ from: old.activityId, error: String(err) });
        }
      }
    } else if (manifest.componentType !== 'service') {
      // activityMode='none': the window IS the instance.
      for (const from of oldInstanceIds) {
        restored.push({ from, to: instanceId, instanceId, path: '/' });
      }
    }

    const dropped = failed.map((f) => f.from);
    const workspacesUpdated = await placeWindows(restored, dropped, before);
    // An older desktop tab's writes for this restart can still be in flight
    // (it claims each new window for its active workspace) — place once more
    // after they have landed. Later moves are the user's and stay.
    setTimeout(() => { placeWindows(restored, dropped, before).catch(() => undefined); }, 3_000);

    const result: RestartResult = { appId, oldInstanceIds, instanceId, restored, failed, workspacesUpdated };
    OsEventBus.emit('app:restarted', result);
    return result;
  } catch (err) {
    OsEventBus.emit('app:restartFailed', { appId, instanceIds: oldInstanceIds, error: String(err) });
    throw err;
  }
}

type Placement = { wsId: string; index: number; rect?: unknown; focused: boolean };

async function readWorkspaces(): Promise<WsShape | null> {
  const entry = await defaultKv().get('os', 'workspaces');
  const state = entry?.value as WsShape | undefined;
  return state && Array.isArray(state.workspaces) ? state : null;
}

/** Where each of `viewIds` sits in `state`: workspace, slot index, stack rect, fullscreen focus. */
function placementsOf(state: WsShape | null, viewIds: string[]): Map<string, Placement> {
  const out = new Map<string, Placement>();
  if (!state) return out;
  for (const id of viewIds) {
    const w = state.workspaces.find((x) => (x.members ?? []).includes(id));
    if (!w) continue;
    out.set(id, {
      wsId: w.id,
      index: w.members.indexOf(id),
      rect: w.layoutState?.rects?.[id],
      focused: w.layoutState?.focusedViewId === id,
    });
  }
  return out;
}

/**
 * Put every restored window back where its old one was in `before` (the
 * snapshot taken before stopping): same workspace, same slot in `members`
 * (tiling order), same stack rect, same fullscreen focus.
 *
 * Works from the snapshot rather than mapping ids in place: a browser still
 * running an older desktop strips the old ids as soon as the instance dies
 * and claims the new ones for its active workspace. So all old and new ids
 * of this restart are cleared from the CURRENT state first, then placed.
 * Returns true when it wrote.
 */
async function placeWindows(
  restored: RestoredActivity[],
  dropped: string[],
  before: Map<string, Placement>,
): Promise<boolean> {
  const state = await readWorkspaces();
  if (!state) return false;
  const ours = new Set([...dropped, ...restored.flatMap((r) => [r.from, r.to])]);
  const next: WsShape = structuredClone(state);
  for (const w of next.workspaces) {
    w.members = (w.members ?? []).filter((m) => !ours.has(m));
    const ls = w.layoutState;
    if (ls?.rects) for (const k of Object.keys(ls.rects)) if (ours.has(k)) delete ls.rects[k];
    if (ls?.focusedViewId && ours.has(ls.focusedViewId)) delete ls.focusedViewId;
  }
  // Ascending old index, so each insert lands at its original slot.
  const todo = restored
    .map((r) => ({ r, p: before.get(r.from) }))
    .filter((x): x is { r: RestoredActivity; p: Placement } => !!x.p)
    .sort((a, b) => a.p.index - b.p.index);
  const placed = new Set<string>();
  for (const { r, p } of todo) {
    if (placed.has(r.to)) continue;  // several old windows → one new view
    const w = next.workspaces.find((x) => x.id === p.wsId);
    if (!w) continue;
    placed.add(r.to);
    w.members.splice(Math.min(p.index, w.members.length), 0, r.to);
    if (p.rect !== undefined) {
      w.layoutState = { ...w.layoutState, rects: { ...w.layoutState?.rects, [r.to]: p.rect } };
    }
    if (p.focused) w.layoutState = { ...w.layoutState, focusedViewId: r.to };
  }
  if (JSON.stringify(next) === JSON.stringify(state)) return false;

  const stored = await defaultKv().set('os', 'workspaces', next);
  // Same events the KV route emits for a browser-side PUT.
  OsEventBus.emit('kv:changed', { namespace: 'os', key: 'workspaces', value: stored.value });
  OsEventBus.emit('workspaces:changed', {
    workspaces: next.workspaces.map((w) => ({
      id: String(w.id ?? ''),
      name: String((w as { name?: unknown }).name ?? ''),
      layoutId: String((w as { layoutId?: unknown }).layoutId ?? 'tiling'),
      memberCount: w.members.length,
    })),
    activeWorkspaceId: next.activeWorkspaceId,
  });
  return true;
}
