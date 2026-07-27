/**
 * The registry of PocketBuilder-owned projects.
 *
 * A project IS an AuraOS app, so the OS already knows about it — but the OS
 * has no notion of "was this created by PocketBuilder?". The manifest can't
 * carry that flag either: core's zod schema strips unknown keys
 * (packages/core/src/types/manifest.ts), so anything we add to
 * app.manifest.json is invisible in `GET /api/apps`.
 *
 * So the durable marker lives in the OS KV under this app's private bucket:
 *   /api/kv/app/io.lakner.pocketbuilder/projects → ProjectRecord[]
 *
 * Every read reconciles that list against `GET /api/apps` — a project removed
 * out-of-band (`aura app rm`, Nexus uninstall) drops out of the dashboard
 * instead of showing up as a phantom card.
 */

import { shellGet, shellPut } from './shellClient.ts';
import { PROJECT_ID_PREFIX } from './template.ts';

export const APP_ID = 'io.lakner.pocketbuilder';
const KV_PATH = `/api/kv/app/${APP_ID}/projects`;

/** Scope every project is scaffolded into. See the plan: `user` survives
 *  image rebuilds and needs no workspace pnpm install. */
export const PROJECT_SCOPE = 'user';

export interface ProjectRecord {
  id:         string;
  name:       string;
  template:   string;
  createdAt:  string;
  gitRemote?: string;
}

export interface AppDto {
  manifest: { id: string; name: string; version: string; description?: string };
  enabled?: boolean;
  instances: Array<{ instanceId: string; state: string; port: number | null; inPool?: boolean }>;
}

/** A project joined with its live OS state. */
export interface Project extends ProjectRecord {
  installed:  boolean;
  running:    boolean;
  state:      string;
  instanceId: string | null;
}

/** Lifecycle states in which the sandbox container actually exists. */
const LIVE_STATES = new Set(['created', 'starting', 'started', 'resuming', 'resumed', 'pausing', 'paused']);

export async function readRecords(): Promise<ProjectRecord[]> {
  try {
    const res = await shellGet<{ value: ProjectRecord[] }>(KV_PATH);
    return Array.isArray(res?.value) ? res.value : [];
  } catch {
    // 404 = never written yet. Any other transport error also degrades to
    // "no projects" rather than blanking the whole dashboard with a stack.
    return [];
  }
}

export async function writeRecords(records: ProjectRecord[]): Promise<void> {
  await shellPut(KV_PATH, { value: records });
}

export async function addRecord(rec: ProjectRecord): Promise<void> {
  const records = await readRecords();
  await writeRecords([...records.filter((r) => r.id !== rec.id), rec]);
}

export async function updateRecord(id: string, patch: Partial<ProjectRecord>): Promise<void> {
  const records = await readRecords();
  await writeRecords(records.map((r) => (r.id === id ? { ...r, ...patch } : r)));
}

export async function removeRecord(id: string): Promise<void> {
  const records = await readRecords();
  await writeRecords(records.filter((r) => r.id !== id));
}

/** Host-side apps dir of the project scope, e.g. /data/scopes/users/default/apps. */
export async function scopeAppsDir(): Promise<string> {
  const scopes = await shellGet<Array<{ id: string; appsDir: string }>>('/api/scopes');
  const scope = scopes.find((s) => s.id === PROJECT_SCOPE);
  if (!scope?.appsDir) throw new Error(`Scope '${PROJECT_SCOPE}' not found in /api/scopes.`);
  return scope.appsDir;
}

/**
 * The dashboard's view: KV records joined with live OS state.
 *
 * Two discovery keys, deliberately. The KV record carries the metadata (which
 * template, when, which remote). The `io.lakner.pocketbuilder.` id prefix is
 * the fallback: any installed app under our namespace that has no record —
 * because KV was cleared, or the app was scaffolded outside the dashboard —
 * still shows up, adopted with what we can infer. Records for apps that are
 * no longer installed drop out rather than showing as phantom cards.
 */
export async function listProjects(): Promise<Project[]> {
  const [records, apps] = await Promise.all([
    readRecords(),
    shellGet<AppDto[]>('/api/apps'),
  ]);
  const byId = new Map(apps.map((a) => [a.manifest.id, a]));

  const known = new Set(records.map((r) => r.id));
  const adopted: ProjectRecord[] = apps
    .filter((a) => a.manifest.id.startsWith(`${PROJECT_ID_PREFIX}.`) && !known.has(a.manifest.id))
    .map((a) => ({
      id:        a.manifest.id,
      name:      a.manifest.name,
      template:  'unknown',
      createdAt: '',
    }));

  return [...records, ...adopted]
    .map((rec) => {
      const app = byId.get(rec.id);
      const live = app?.instances.find((i) => LIVE_STATES.has(i.state) && !i.inPool) ?? null;
      return {
        ...rec,
        installed:  !!app,
        running:    !!live,
        state:      live?.state ?? (app ? 'stopped' : 'missing'),
        instanceId: live?.instanceId ?? null,
      };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getProject(id: string): Promise<Project | null> {
  return (await listProjects()).find((p) => p.id === id) ?? null;
}

/** Everything a docker.ts call needs to reach a project. */
export async function runTargetFor(project: Project): Promise<{ projectId: string; instanceId: string | null; scopeAppsDir: string }> {
  return {
    projectId:    project.id,
    instanceId:   project.instanceId,
    scopeAppsDir: await scopeAppsDir(),
  };
}
