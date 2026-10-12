/**
 * Resource registry behind the kubectl-style verbs (`aura get <res>`,
 * `aura describe <res> <name>`, `aura api-resources`, completion).
 *
 * One `ResourceDef` per kind: its names (canonical plural first, then short
 * names), how to list it, which columns a table shows, and which verbs accept
 * it. The verbs themselves stay thin — anything that mutates is delegated to
 * the existing commands (see commands/verbs.ts), so this file only READS.
 */
import { api } from './client.js';
import { color, stateColor, uptime } from './format.js';
import { ensureRegistry, loadRegistry, loadState, type State } from './registry.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── API shapes (one copy, shared by every resource) ────────────────────────

export interface InstanceDto {
  instanceId: string;
  appId: string;
  state: string;
  port: number | null;
  pid?: number | null;
  startedAt?: string | null;
  inPool?: boolean;
  sandbox?: 'proot' | 'container';
}

export interface ActivityDto {
  activityId: string;
  parentInstanceId: string;
  appId: string;
  path: string;
  title?: string;
}

export interface AppDto {
  manifest: {
    id: string;
    name: string;
    version: string;
    instanceMode?: string;
    activityMode?: string;
    backgroundService?: boolean;
    componentType?: 'activity' | 'service';
    sandbox?: string;
    tools?: string[];
    permissions?: string[];
  };
  enabled?: boolean;
  instances: InstanceDto[];
  activities: ActivityDto[];
}

/** `GET /api/instances/:id/sidecars` items (core `SidecarInfo` + usage). */
export interface SidecarDto {
  /** Backend-unique id — the container name for the container backend. */
  id: string;
  /** `aura.service` label; empty for raw containers that only carry `aura.parent`. */
  service: string;
  parentInstanceId: string;
  appId: string;
  backend: string;
  state: string;
  image?: string;
  createdAt?: string;
  managedBy?: 'os' | 'app';
  template?: string;
  usage?: { memBytes: number | null; cpuPct: number | null } | null;
}

export interface MountDto {
  id: string;
  instanceId: string;
  targetAppId: string;
  kind: string;
  mode: string;
  containerPath: string;
  origin?: string;
}

export interface PortDto {
  id: string;
  kind: string;
  ownerInstanceId: string;
  sourceAppId: string;
  sourcePort: number;
  port: number;
  bindAddr?: string;
  sticky: boolean;
}

// ─── Shared fetchers ────────────────────────────────────────────────────────

export async function fetchApps(): Promise<AppDto[]> {
  return api.get<AppDto[]>('/api/apps');
}

export function allInstances(apps: AppDto[]): InstanceDto[] {
  return apps.flatMap((a) => a.instances);
}

/** Instances that actually serve something (no warm-pool spares, no dead ones). */
export function liveInstances(apps: AppDto[]): InstanceDto[] {
  return allInstances(apps).filter((i) => !i.inPool && ['resumed', 'paused', 'started', 'created'].includes(i.state));
}

/**
 * The sidecar ID users type: the declared service name, or the container name
 * for raw siblings that carry no `aura.service` label (e.g. containers a
 * sidecar spawned itself). Unique within its instance.
 */
export function sidecarId(s: SidecarDto): string {
  return s.service || s.id;
}

/** Does `token` name this sidecar? Accepts the ID, the container name, or `aura-<inst>--<token>`. */
export function sidecarMatches(s: SidecarDto, token: string): boolean {
  return s.service === token || s.id === token || s.id === `aura-${s.parentInstanceId}--${token}`;
}

export async function fetchSidecars(instanceId: string): Promise<SidecarDto[]> {
  // usage=0: the list view needs no `docker stats` round-trip. Older shells
  // ignore the flag and return the usage payload, which carries the same items.
  const res = await api.get<{ sidecars: SidecarDto[] }>(
    `/api/instances/${encodeURIComponent(instanceId)}/sidecars?usage=0`,
  );
  return res.sidecars ?? [];
}

// ─── Resource definitions ───────────────────────────────────────────────────

export interface Ctx {
  /** `-a, --app` filter. */
  app?: string;
  /** `-i, --instance` scope. */
  instance?: string;
}

export interface Column<T> {
  header: string;
  value: (o: T) => string;
  /** Only shown with `-o wide`. */
  wide?: boolean;
}

export interface ResourceDef<T = any> {
  /** Canonical plural, e.g. `instances`. */
  name: string;
  /** Singular + short names, e.g. `['instance', 'inst']`. */
  aliases: string[];
  description: string;
  /** Verbs that accept this resource (for help + api-resources + completion). */
  verbs: string[];
  /** Flags `get` honours for this resource. */
  scopes?: Array<'app' | 'instance'>;
  nameOf: (o: T) => string;
  list: (ctx: Ctx) => Promise<T[]>;
  columns: Column<T>[];
  /** SSE-driven `get -w` is supported (state lives in the app registry). */
  watchable?: boolean;
}

const apps: ResourceDef<AppDto> = {
  name: 'apps',
  aliases: ['app'],
  description: 'Installed apps (manifest + instance count)',
  verbs: ['get', 'describe', 'run', 'stop', 'restart', 'delete', 'install', 'enable', 'disable', 'grant', 'revoke'],
  nameOf: (a) => a.manifest.id,
  list: async () => fetchApps(),
  watchable: true,
  columns: [
    { header: 'ID', value: (a) => a.manifest.id },
    { header: 'NAME', value: (a) => a.manifest.name },
    { header: 'VERSION', value: (a) => a.manifest.version },
    { header: 'INSTANCES', value: (a) => String(a.instances.length) },
    { header: 'MODE', value: (a) => `${a.manifest.instanceMode ?? '-'}/${a.manifest.activityMode ?? '-'}`, wide: true },
    { header: 'SANDBOX', value: (a) => a.manifest.sandbox ?? 'proot', wide: true },
    { header: 'BG', value: (a) => (a.manifest.backgroundService ? 'yes' : '-'), wide: true },
    { header: 'EN', value: (a) => (a.enabled === false ? color.red('off') : color.green('on')) },
  ],
};

interface InstanceRow extends InstanceDto { activities: number }

const instances: ResourceDef<InstanceRow> = {
  name: 'instances',
  aliases: ['instance', 'inst'],
  description: 'Running app instances (sandboxes); subresource: sidecars',
  verbs: ['get', 'describe', 'stop', 'kill', 'pause', 'resume', 'exec', 'logs'],
  scopes: ['app'],
  nameOf: (i) => i.instanceId,
  watchable: true,
  list: async (ctx) => {
    const all = await fetchApps();
    return all
      .filter((a) => !ctx.app || a.manifest.id === ctx.app)
      .flatMap((a) => a.instances.map((i) => ({
        ...i,
        activities: a.activities.filter((x) => x.parentInstanceId === i.instanceId).length,
      })));
  },
  columns: [
    { header: 'INSTANCE', value: (i) => i.instanceId },
    { header: 'APP', value: (i) => i.appId },
    { header: 'STATE', value: (i) => stateColor(i.state) },
    { header: 'PORT', value: (i) => i.port?.toString() ?? '-' },
    { header: 'ACTIVITIES', value: (i) => String(i.activities) },
    { header: 'SANDBOX', value: (i) => i.sandbox ?? '-', wide: true },
    { header: 'PID', value: (i) => i.pid?.toString() ?? '-', wide: true },
    { header: 'POOL', value: (i) => (i.inPool ? 'yes' : '-'), wide: true },
    { header: 'UPTIME', value: (i) => uptime(i.startedAt) },
  ],
};

const sidecars: ResourceDef<SidecarDto> = {
  name: 'sidecars',
  aliases: ['sidecar', 'sc'],
  description: 'Containers an instance runs next to itself (databases, agents, …)',
  verbs: ['get', 'describe', 'exec', 'logs'],
  scopes: ['app', 'instance'],
  nameOf: (s) => sidecarId(s),
  watchable: true,
  list: async (ctx) => {
    const all = await fetchApps();
    let ids: string[];
    if (ctx.instance) ids = [ctx.instance];
    else ids = allInstances(all).filter((i) => !ctx.app || i.appId === ctx.app).map((i) => i.instanceId);
    const out: SidecarDto[] = [];
    for (const id of ids) {
      try { out.push(...await fetchSidecars(id)); }
      catch (err) { if (ctx.instance) throw err; /* instance vanished mid-loop */ }
    }
    return out;
  },
  columns: [
    { header: 'ID', value: (s) => sidecarId(s) },
    { header: 'INSTANCE', value: (s) => s.parentInstanceId },
    { header: 'STATE', value: (s) => sidecarState(s.state) },
    { header: 'MANAGED', value: (s) => s.managedBy ?? 'app' },
    { header: 'IMAGE', value: (s) => s.image ?? '-' },
    { header: 'CONTAINER', value: (s) => s.id, wide: true },
    { header: 'TEMPLATE', value: (s) => s.template ?? '-', wide: true },
    { header: 'AGE', value: (s) => uptime(s.createdAt) },
  ],
};

function sidecarState(state: string): string {
  if (state === 'running') return color.green(state);
  if (state === 'starting') return color.yellow(state);
  if (state === 'error') return color.red(state);
  return color.dim(state);
}

const activities: ResourceDef<ActivityDto> = {
  name: 'activities',
  aliases: ['activity', 'act'],
  description: 'Open UI screens (windows) of running instances',
  verbs: ['get', 'open', 'delete'],
  scopes: ['app', 'instance'],
  nameOf: (a) => a.activityId,
  watchable: true,
  list: async (ctx) => {
    if (ctx.instance) {
      return api.get<ActivityDto[]>(`/api/instances/${encodeURIComponent(ctx.instance)}/activities`);
    }
    const all = await fetchApps();
    return all.flatMap((a) => a.activities).filter((a) => !ctx.app || a.appId === ctx.app);
  },
  columns: [
    { header: 'ACTIVITY', value: (a) => a.activityId },
    { header: 'INSTANCE', value: (a) => a.parentInstanceId },
    { header: 'APP', value: (a) => a.appId },
    { header: 'PATH', value: (a) => a.path },
    { header: 'TITLE', value: (a) => a.title ?? '-' },
  ],
};

interface CapRow { name: string; source: string; installed: boolean; declaredBy: string[] }

const capabilities: ResourceDef<CapRow> = {
  name: 'capabilities',
  aliases: ['capability', 'caps', 'cap'],
  description: 'Shareable CLI tools from the registry (granted per app via tools[])',
  verbs: ['get', 'describe', 'install', 'delete', 'grant', 'revoke'],
  scopes: ['app'],
  nameOf: (c) => c.name,
  list: async (ctx) => {
    ensureRegistry();
    const reg = loadRegistry();
    // The shell is the state writer; the local file can be stale inside a PRoot.
    let state: State;
    try { state = (await api.get<{ state: State }>('/api/admin/cap')).state; }
    catch { state = loadState(); }
    const manifests = (await fetchApps()).map((a) => a.manifest);
    return Object.entries(reg.capabilities)
      .map(([name, entry]) => {
        const installed = state.capabilities[name]?.installed === true || entry.source === 'builtin';
        const declaredBy = manifests
          .filter((m) => Array.isArray(m.tools) && (m.tools.includes(name) || (installed && m.tools.includes('*'))))
          .map((m) => m.id);
        return { name, source: entry.source, installed, declaredBy };
      })
      .filter((c) => !ctx.app || c.declaredBy.includes(ctx.app));
  },
  columns: [
    { header: 'NAME', value: (c) => c.name },
    { header: 'SOURCE', value: (c) => c.source },
    { header: 'INSTALLED', value: (c) => (c.installed ? color.green('✓') : color.dim('✗')) },
    { header: 'APPS', value: (c) => String(c.declaredBy.length) },
    { header: 'DECLARED-BY', value: (c) => (c.declaredBy.length ? c.declaredBy.join(',') : color.dim('-')), wide: true },
  ],
};

interface ServiceRow { name: string; source: string; installed: boolean; running: boolean; pid: number | null; port: number | null }

const SERVICES_DIR = '/data/aura/state/services';

const services: ResourceDef<ServiceRow> = {
  name: 'services',
  aliases: ['service', 'svc'],
  description: 'Long-running daemons on the master (sshd, code-server, …)',
  verbs: ['get', 'describe', 'start', 'stop', 'install', 'delete', 'logs'],
  nameOf: (s) => s.name,
  list: async () => {
    ensureRegistry();
    const reg = loadRegistry();
    const state = loadState();
    return Object.entries(reg.services).map(([name, entry]) => {
      let pid: number | null = null;
      const pf = join(SERVICES_DIR, `${name}.pid`);
      if (existsSync(pf)) {
        const n = Number(readFileSync(pf, 'utf-8').trim());
        if (Number.isFinite(n)) {
          try { process.kill(n, 0); pid = n; } catch { /* stale pid file */ }
        }
      }
      return {
        name,
        source: entry.source,
        installed: state.services[name]?.installed === true,
        running: pid !== null,
        pid,
        port: entry.port ?? null,
      };
    });
  },
  columns: [
    { header: 'NAME', value: (s) => s.name },
    { header: 'SOURCE', value: (s) => s.source },
    { header: 'INSTALLED', value: (s) => (s.installed ? color.green('✓') : color.dim('✗')) },
    { header: 'RUNNING', value: (s) => (s.running ? color.green('✓') : color.dim('✗')) },
    { header: 'PID', value: (s) => s.pid?.toString() ?? '-', wide: true },
    { header: 'PORT', value: (s) => s.port?.toString() ?? '-' },
  ],
};

const mounts: ResourceDef<MountDto> = {
  name: 'mounts',
  aliases: ['mount'],
  description: 'Cross-app mounts into a container instance (`aura mount`)',
  verbs: ['get', 'delete'],
  scopes: ['app', 'instance'],
  nameOf: (m) => m.id,
  list: async (ctx) => {
    let ids: string[];
    if (ctx.instance) ids = [ctx.instance];
    else {
      const all = await fetchApps();
      ids = liveInstances(all)
        .filter((i) => i.sandbox === 'container' && (!ctx.app || i.appId === ctx.app))
        .map((i) => i.instanceId);
    }
    const out: MountDto[] = [];
    for (const id of ids) {
      try {
        const res = await api.get<{ mounts: MountDto[] }>(`/api/instances/${encodeURIComponent(id)}/mounts`);
        out.push(...(res.mounts ?? []));
      } catch (err) { if (ctx.instance) throw err; }
    }
    return out;
  },
  columns: [
    { header: 'INSTANCE', value: (m) => m.instanceId },
    { header: 'TARGET', value: (m) => m.id },
    { header: 'KIND', value: (m) => m.kind },
    { header: 'MODE', value: (m) => (m.mode === 'rw' ? color.yellow('rw') : 'ro') },
    { header: 'PATH', value: (m) => m.containerPath },
    { header: 'ORIGIN', value: (m) => m.origin ?? '-', wide: true },
  ],
};

const ports: ResourceDef<PortDto> = {
  name: 'ports',
  aliases: ['port'],
  description: 'Port exposes into another app or onto the host (`aura port`)',
  verbs: ['get', 'delete'],
  scopes: ['app', 'instance'],
  nameOf: (p) => p.id,
  list: async (ctx) => {
    const all = await fetchApps();
    const owners = liveInstances(all)
      .filter((i) => (!ctx.instance || i.instanceId === ctx.instance) && (!ctx.app || i.appId === ctx.app));
    const out: Array<PortDto & { ownerAppId?: string }> = [];
    for (const inst of owners) {
      try {
        const res = await api.get<{ ports: PortDto[] }>(`/api/instances/${encodeURIComponent(inst.instanceId)}/ports`);
        out.push(...(res.ports ?? []));
      } catch { /* vanished mid-loop */ }
    }
    return out;
  },
  columns: [
    { header: 'OWNER', value: (p) => p.ownerInstanceId },
    { header: 'ID', value: (p) => p.id },
    { header: 'KIND', value: (p) => p.kind },
    { header: 'SOURCE', value: (p) => `${p.sourceAppId}:${p.sourcePort}` },
    { header: 'LISTEN', value: (p) => (p.kind === 'host' ? `host ${p.bindAddr}:${p.port}` : `target 127.0.0.1:${p.port}`) },
    { header: 'STICKY', value: (p) => (p.sticky ? 'yes' : '') },
  ],
};

interface ScopeRow { id: string; appsDir: string; dataDir: string; immutable: boolean; appCount: number; gitRepo: string | null }

const scopes: ResourceDef<ScopeRow> = {
  name: 'scopes',
  aliases: ['scope'],
  description: 'App installation scopes (system / global / user)',
  verbs: ['get'],
  nameOf: (s) => s.id,
  list: async () => api.get<ScopeRow[]>('/api/scopes'),
  columns: [
    { header: 'SCOPE', value: (s) => s.id },
    { header: 'APPS', value: (s) => String(s.appCount) },
    { header: 'IMMUTABLE', value: (s) => (s.immutable ? 'yes' : 'no') },
    { header: 'APPS-DIR', value: (s) => s.appsDir },
    { header: 'DATA-DIR', value: (s) => s.dataDir, wide: true },
    { header: 'GIT', value: (s) => s.gitRepo ?? '—' },
  ],
};

interface ThemeRow { id: string; name: string; tone?: string; active: string }

const themes: ResourceDef<ThemeRow> = {
  name: 'themes',
  aliases: ['theme'],
  description: 'Theme presets; ACTIVE marks the dark/light slot in use',
  verbs: ['get', 'set'],
  nameOf: (t) => t.id,
  list: async () => {
    const data = await api.get<{ themes: Array<{ id: string; name: string; tone?: string }> }>('/api/os/themes');
    const cur = await api
      .get<{ value?: { themeIdDark?: string; themeIdLight?: string } }>('/api/kv/os/theme')
      .catch(() => null);
    return (data.themes ?? []).map((t) => ({
      ...t,
      active: [t.id === cur?.value?.themeIdDark ? 'dark' : '', t.id === cur?.value?.themeIdLight ? 'light' : '']
        .filter(Boolean).join(','),
    }));
  },
  columns: [
    { header: 'ID', value: (t) => t.id },
    { header: 'NAME', value: (t) => t.name },
    { header: 'TONE', value: (t) => t.tone ?? '-' },
    { header: 'ACTIVE', value: (t) => (t.active ? color.green(t.active) : '') },
  ],
};

interface PermRow { app: string; permissions: string[] }

const permissions: ResourceDef<PermRow> = {
  name: 'permissions',
  aliases: ['permission', 'perms', 'perm'],
  description: "Apps' declared manifest permissions[]",
  verbs: ['get', 'grant', 'revoke'],
  scopes: ['app'],
  nameOf: (p) => p.app,
  list: async (ctx) => (await fetchApps())
    .filter((a) => !ctx.app || a.manifest.id === ctx.app)
    .map((a) => ({ app: a.manifest.id, permissions: a.manifest.permissions ?? [] }))
    .sort((a, b) => a.app.localeCompare(b.app)),
  columns: [
    { header: 'APP', value: (p) => p.app },
    { header: 'PERMISSIONS', value: (p) => (p.permissions.length ? p.permissions.join(', ') : color.dim('(none)')) },
  ],
};

/** Display order for help, api-resources and completion. */
export const RESOURCES: ResourceDef[] = [
  apps, instances, sidecars, activities, capabilities, services, mounts, ports, scopes, themes, permissions,
];

/** Look a resource up by any of its names (`inst`, `instance`, `instances`). */
export function findResource(token: string): ResourceDef | undefined {
  const t = token.toLowerCase();
  return RESOURCES.find((r) => r.name === t || r.aliases.includes(t));
}

/** `apps (app)`-style label used in help text. */
export function resourceLabel(r: ResourceDef): string {
  return `${r.name} (${r.aliases.join(', ')})`;
}

/** Resources a verb accepts, by their shortest name, for usage lines. */
export function resourcesFor(verb: string): string[] {
  return RESOURCES.filter((r) => r.verbs.includes(verb)).map((r) => shortName(r));
}

export function shortName(r: ResourceDef): string {
  return [r.name, ...r.aliases].reduce((a, b) => (b.length < a.length ? b : a));
}
