/**
 * The desktop as one model: what the server knows (apps, workspaces,
 * layouts) joined with what only the browser knows (the live windows, their
 * user-given names, focus, zoom, panels). Every tool reads from here; the
 * overview tool is just this model summarised.
 */
import {
  getWorkspaces, listApps, listLayouts, ui,
  type ActivityLite, type AppRecord, type InstanceLite, type LayoutMeta, type WorkspaceState,
} from './shell-api.ts';
import type { AppSummary, ProcessSummary, WindowSummary, WorkspaceSummary } from './resolve.ts';

/** What the browser answers to the `snapshot` command (see packages/shell/src/lib/uiCommands.ts). */
export interface UiSnapshot {
  desktop?: {
    activeWorkspaceId: string | null;
    focusedViewId: string | null;
    maximizedViewId: string | null;
    maximizedFull: boolean;
    navMode: string;
    windows: Array<{
      viewId: string; appId: string; instanceId: string; activityId: string | null;
      title: string; name: string | null; sessionLabel: string | null;
      state: string; isFocused: boolean; workspaceId: string | null;
    }>;
  };
  statusBar?: {
    zoom: { percent: number; shellPercent: number; appPercent: number; min: number; max: number; step: number };
    fullscreen: boolean;
    layouts: LayoutMeta[];
  };
  launcher?: { open: boolean; query: string };
  processManager?: { open: boolean; filters: { apps: boolean; services: boolean } };
  lockScreen?: { active: boolean | null };
}

export interface WorkspaceLine { number: number; name: string; layout: string }

export interface ShellState {
  apps: AppRecord[];
  appSummaries: AppSummary[];
  /** Display names shared by more than one app — those get their id shown. */
  nameConflicts: Set<string>;
  workspaces: WorkspaceState;
  wsSummaries: WorkspaceSummary[];
  active: WorkspaceSummary;
  layouts: LayoutMeta[];
  windows: WindowSummary[];
  /** Present when a browser answered; null when none is connected. */
  ui: UiSnapshot | null;
  uiError: string | null;
}

export function summariseWorkspaces(ws: WorkspaceState): WorkspaceSummary[] {
  return ws.workspaces.map((w, i) => ({ number: i + 1, id: w.id, name: w.name, layoutId: w.layoutId }));
}

export function activeOf(ws: WorkspaceState): WorkspaceSummary {
  const list = summariseWorkspaces(ws);
  return list.find((w) => w.id === ws.activeWorkspaceId) ?? list[0]!;
}

export function workspaceLine(w: WorkspaceSummary, layouts: readonly LayoutMeta[]): WorkspaceLine {
  return { number: w.number, name: w.name, layout: layouts.find((l) => l.id === w.layoutId)?.name ?? w.layoutId };
}

export function summariseApps(apps: readonly AppRecord[]): { list: AppSummary[]; conflicts: Set<string> } {
  const seen = new Map<string, number>();
  for (const a of apps) { const k = a.manifest.name.trim().toLowerCase(); seen.set(k, (seen.get(k) ?? 0) + 1); }
  const conflicts = new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
  const list = apps.map((a) => ({
    id: a.manifest.id, name: a.manifest.name,
    service: a.manifest.componentType === 'service', enabled: a.enabled,
  }));
  return { list, conflicts };
}

/** The name a person uses for an app — with the id attached only when the name is shared. */
export function appLabel(state: Pick<ShellState, 'apps' | 'nameConflicts'>, appId: string): string {
  const m = state.apps.find((a) => a.manifest.id === appId)?.manifest;
  if (!m) return appId;
  return state.nameConflicts.has(m.name.trim().toLowerCase()) ? `${m.name} (${m.id})` : m.name;
}

/** Windows as the server can reconstruct them: workspace members ⨝ activities/instances. */
function windowsFromServer(apps: readonly AppRecord[], ws: WorkspaceState, label: (appId: string) => string): WindowSummary[] {
  const activities = new Map<string, ActivityLite>();
  const instances  = new Map<string, InstanceLite>();
  for (const a of apps) {
    for (const act of a.activities) activities.set(act.activityId, act);
    for (const inst of a.instances)  instances.set(inst.instanceId, inst);
  }
  const out: WindowSummary[] = [];
  ws.workspaces.forEach((w, i) => {
    for (const viewId of w.members) {
      const act = activities.get(viewId);
      const inst = act ? instances.get(act.parentInstanceId) : instances.get(viewId);
      const appId = act?.appId ?? inst?.appId;
      if (!appId) continue;   // a member whose backend is gone
      out.push({
        viewId, app: label(appId), appId, instanceId: act?.parentInstanceId ?? viewId,
        activityId: act?.activityId ?? null, name: null, title: act?.title ?? label(appId),
        workspace: { number: i + 1, name: w.name },
      });
    }
  });
  return out;
}

function windowsFromBrowser(snap: NonNullable<UiSnapshot['desktop']>, ws: WorkspaceState, label: (appId: string) => string): WindowSummary[] {
  const byId = new Map(summariseWorkspaces(ws).map((w) => [w.id, w]));
  return snap.windows.map((w) => {
    const owner = w.workspaceId ? byId.get(w.workspaceId) : undefined;
    return {
      viewId: w.viewId, app: label(w.appId), appId: w.appId, instanceId: w.instanceId, activityId: w.activityId,
      name: w.name, title: w.title, workspace: owner ? { number: owner.number, name: owner.name } : null,
      // A view keeps its focus flag while its workspace is hidden; only the
      // active workspace's focused window is the one a person would call focused.
      state: w.state, focused: w.isFocused && w.workspaceId === ws.activeWorkspaceId,
    };
  });
}

/** Load the model. `snapshot: true` also asks the browser (one round trip). */
export async function loadState(opts: { snapshot?: boolean } = {}): Promise<ShellState> {
  const [apps, workspaces, layouts, snap] = await Promise.all([
    listApps(), getWorkspaces(), listLayouts().catch(() => [] as LayoutMeta[]),
    opts.snapshot ? ui<UiSnapshot>('snapshot', {}, 4_000) : Promise.resolve(null),
  ]);
  const { list, conflicts } = summariseApps(apps);
  const partial = { apps, nameConflicts: conflicts };
  const label = (appId: string) => appLabel(partial, appId);
  const uiSnap = snap && snap.ok ? snap.result : null;
  return {
    apps, appSummaries: list, nameConflicts: conflicts,
    workspaces, wsSummaries: summariseWorkspaces(workspaces), active: activeOf(workspaces),
    layouts,
    windows: uiSnap?.desktop ? windowsFromBrowser(uiSnap.desktop, workspaces, label) : windowsFromServer(apps, workspaces, label),
    ui: uiSnap,
    uiError: snap && !snap.ok ? snap.message : null,
  };
}

/** The process manager's chip label for a lifecycle state (copied from ProcessManager.astro). */
export function stateLabel(state: string): string {
  switch (state) {
    case 'resumed':    return 'RUN';
    case 'paused': case 'pausing': return 'PSE';
    case 'creating': case 'created': case 'starting': case 'started': case 'resuming': return 'BOOT';
    case 'stopping': case 'stopped': return 'STOP';
    case 'destroying': return 'TERM';
    case 'destroyed':  return 'OFF';
    case 'error': case 'crashed': return 'ERR';
    default: return state.toUpperCase().slice(0, 4);
  }
}

/** Running processes as the process manager lists them (warm-pool members hidden). */
export function processes(state: Pick<ShellState, 'apps' | 'nameConflicts'>): ProcessSummary[] {
  const out: ProcessSummary[] = [];
  for (const a of state.apps) {
    for (const inst of a.instances) {
      if (inst.inPool) continue;
      out.push({
        instanceId: inst.instanceId, app: appLabel(state, a.manifest.id), appId: a.manifest.id,
        kind: a.manifest.componentType === 'service' ? 'service' : 'app',
        state: inst.state, label: stateLabel(inst.state), pid: inst.pid, port: inst.port,
        activities: a.activities.filter((x) => x.parentInstanceId === inst.instanceId)
          .map((x) => ({ activityId: x.activityId, title: x.title ?? null })),
      });
    }
  }
  return out;
}

/** A window the way the overview and the window tools print it. */
export function windowView(w: WindowSummary) {
  return {
    app: w.app, name: w.name, title: w.title, viewId: w.viewId,
    workspace: w.workspace ? `${w.workspace.number} ${w.workspace.name}` : null,
    ...(w.state ? { state: w.state } : {}), ...(w.focused ? { focused: true } : {}),
  };
}
