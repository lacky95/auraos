/**
 * Human references → things. Pure, so the tests need no OS.
 *
 * Every tool takes what a person would say — "Terminal", "workspace 2",
 * "Free Window", the name they gave a window — and only falls back to ids
 * when a name is genuinely ambiguous. Matching runs in tiers (exact id,
 * exact name, then substring); the first tier with any hit decides, and more
 * than one hit in that tier is reported as `many` with the candidates, never
 * guessed.
 */
export type Match<T> =
  | { kind: 'one'; value: T }
  | { kind: 'none'; message: string }
  | { kind: 'many'; candidates: T[] };

export interface AppSummary { id: string; name: string; service: boolean; enabled: boolean }
export interface WorkspaceSummary { number: number; id: string; name: string; layoutId: string }
export interface LayoutMeta { id: string; name: string; description?: string }
export interface WindowSummary {
  viewId: string;
  app: string;
  appId: string;
  instanceId: string;
  activityId: string | null;
  /** The label the user (or an agent) gave the window; null when none. */
  name: string | null;
  title: string;
  workspace: { number: number; name: string } | null;
  state?: string;
  focused?: boolean;
}
export interface ProcessSummary {
  instanceId: string;
  app: string;
  appId: string;
  kind: 'app' | 'service';
  state: string;
  label: string;
  pid: number | null;
  port: number | null;
  activities: Array<{ activityId: string; title: string | null }>;
}

export const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

function byTiers<T>(items: readonly T[], tiers: Array<(t: T) => boolean>, none: string): Match<T> {
  for (const test of tiers) {
    const hits = items.filter(test);
    if (hits.length === 1) return { kind: 'one', value: hits[0]! };
    if (hits.length > 1)   return { kind: 'many', candidates: hits };
  }
  return { kind: 'none', message: none };
}

export function resolveApp(apps: readonly AppSummary[], ref: string): Match<AppSummary> {
  const raw = String(ref ?? '').trim();
  const q = norm(raw);
  if (!q) return { kind: 'none', message: 'give an app name (or id)' };
  return byTiers(apps, [
    (a) => a.id === raw,
    (a) => norm(a.name) === q,
    (a) => norm(a.name).includes(q) || a.id.toLowerCase().includes(q),
  ], `no app called "${raw}"`);
}

export function resolveWorkspace(list: readonly WorkspaceSummary[], ref: string | number): Match<WorkspaceSummary> {
  const raw = String(ref ?? '').trim();
  if (typeof ref === 'number' || /^\d+$/.test(raw)) {
    const n = Number(raw);
    const w = list.find((x) => x.number === n);
    return w ? { kind: 'one', value: w }
             : { kind: 'none', message: `there is no workspace ${n} — there ${list.length === 1 ? 'is' : 'are'} ${list.length}` };
  }
  const q = norm(raw);
  if (!q) return { kind: 'none', message: 'give a workspace number or name' };
  return byTiers(list, [
    (w) => w.id === raw,
    (w) => norm(w.name) === q,
    (w) => norm(w.name).includes(q),
  ], `no workspace called "${raw}"`);
}

export function resolveLayout(layouts: readonly LayoutMeta[], ref: string): Match<LayoutMeta> {
  const q = norm(ref);
  if (!q) return { kind: 'none', message: 'give a layout name' };
  return byTiers(layouts, [
    (l) => l.id.toLowerCase() === q,
    (l) => norm(l.name) === q,
    (l) => norm(l.name).includes(q) || l.id.toLowerCase().includes(q),
  ], `no layout called "${ref}"; available: ${layouts.map((l) => l.name).join(', ')}`);
}

export function nextLayout(layouts: readonly LayoutMeta[], currentId: string): LayoutMeta {
  if (layouts.length === 0) throw new Error('no layouts are registered');
  const i = layouts.findIndex((l) => l.id === currentId);
  return layouts[(i + 1) % layouts.length]!;
}

export function resolveWindow(windows: readonly WindowSummary[], ref: string): Match<WindowSummary> {
  const raw = String(ref ?? '').trim();
  const q = norm(raw);
  if (!q) return { kind: 'none', message: 'give a window name, app name or window id' };
  return byTiers(windows, [
    (w) => w.viewId === raw || w.activityId === raw || w.instanceId === raw,
    (w) => norm(w.name) === q,
    (w) => norm(w.app) === q,
    (w) => norm(w.title) === q,
    (w) => norm(w.name).includes(q) || norm(w.app).includes(q) || norm(w.title).includes(q),
  ], `no open window matches "${raw}"`);
}

export function resolveProcess(procs: readonly ProcessSummary[], ref: string): Match<ProcessSummary> {
  const raw = String(ref ?? '').trim();
  const q = norm(raw);
  if (!q) return { kind: 'none', message: 'give a process (app name or instance id)' };
  return byTiers(procs, [
    (p) => p.instanceId === raw,
    (p) => norm(p.app) === q,
    (p) => p.appId.toLowerCase() === q,
    (p) => norm(p.app).includes(q) || p.instanceId.toLowerCase().includes(q),
  ], `no running process matches "${raw}"`);
}
