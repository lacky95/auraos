/**
 * The settings overlay (Phase 6 stream O, level 1 of 5.5): the owner's grants on an app, kept
 * beside the installed tree instead of in it. One file per app at
 * `/data/aura/overlay/apps/<appId>.json` (release/paths.ts `overlayApp`):
 *
 *   { v: 1,
 *     tools:       { add: [...], remove: [...] },
 *     services:    { <template>: { tools: { add: [...], remove: [...] } } },
 *     permissions: { add: [...], remove: [...] } }
 *
 * Ops, not a copy: a release (or a Nexus update) that changes the tracked manifest still merges
 * predictably, and the installed tree stays untouched (Track P's tree digest stays valid). It
 * carries grants only, never files (it is not the app overlays Q6/D68 removed).
 *
 * `AppRegistry` applies it whenever it loads a manifest, for every scope (one path).
 * `/api/admin/manifest-edit` writes it (`editManifestOverlay`) and nothing writes
 * `app.manifest.json` for a grant any more. `release/overlayMigration.ts` turns local edits of
 * tracked manifests into these ops once.
 *
 * Merge rule per list: the base list without `remove`, then `add` (in order, no duplicates).
 * A service template the base no longer declares is ignored (its ops wait for it). An overlay
 * that is present but invalid fails closed: the registry refuses the app (like an invalid
 * manifest) rather than silently dropping a revoke.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST_OVERLAY_VERSION = 1;

export interface OverlayListOps { add: string[]; remove: string[] }
export interface ManifestOverlay {
  v: 1;
  tools?: OverlayListOps;
  services?: Record<string, { tools: OverlayListOps }>;
  permissions?: OverlayListOps;
}

/** One grant change, as `/api/admin/manifest-edit` names it. */
export type OverlayEdit =
  | { action: 'add-tool' | 'remove-tool'; tool: string }
  | { action: 'set-tools'; tools: string[] }
  | { action: 'add-permission' | 'remove-permission'; permission: string }
  | { action: 'add-service-tool' | 'remove-service-tool'; service: string; tool: string };

export class ManifestOverlayError extends Error {
  constructor(message: string) { super(message); this.name = 'ManifestOverlayError'; }
}

const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ITEM_MAX = 256;

/** The overlay file of one app in an overlay apps dir. */
export function manifestOverlayPath(overlayAppsDir: string, appId: string): string {
  if (!APP_ID_RE.test(appId) || appId.includes('..')) throw new ManifestOverlayError(`bad app id ${JSON.stringify(appId)}`);
  return join(overlayAppsDir, `${appId}.json`);
}

function parseOps(v: unknown, where: string): OverlayListOps {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ManifestOverlayError(`${where} must be { add, remove }`);
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'add' && k !== 'remove');
  if (extra.length) throw new ManifestOverlayError(`${where}: unknown field ${extra.join(', ')}`);
  const list = (x: unknown, k: string): string[] => {
    if (x === undefined) return [];
    if (!Array.isArray(x) || x.some((i) => typeof i !== 'string' || i.length === 0 || i.length > ITEM_MAX)) {
      throw new ManifestOverlayError(`${where}.${k} must be a list of names`);
    }
    return [...new Set(x as string[])];
  };
  const add = list(o['add'], 'add');
  const remove = list(o['remove'], 'remove');
  const both = add.filter((i) => remove.includes(i));
  if (both.length) throw new ManifestOverlayError(`${where}: ${both.join(', ')} is both added and removed`);
  return { add, remove };
}

/** Validate an overlay document (throws ManifestOverlayError). */
export function parseManifestOverlay(doc: unknown): ManifestOverlay {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new ManifestOverlayError('overlay must be an object');
  const o = doc as Record<string, unknown>;
  if (o['v'] !== MANIFEST_OVERLAY_VERSION) throw new ManifestOverlayError(`overlay version must be ${MANIFEST_OVERLAY_VERSION}`);
  const extra = Object.keys(o).filter((k) => !['v', 'tools', 'services', 'permissions'].includes(k));
  if (extra.length) throw new ManifestOverlayError(`unknown field ${extra.join(', ')}`);
  const out: ManifestOverlay = { v: 1 };
  if (o['tools'] !== undefined) out.tools = parseOps(o['tools'], 'tools');
  if (o['permissions'] !== undefined) out.permissions = parseOps(o['permissions'], 'permissions');
  if (o['services'] !== undefined) {
    const s = o['services'];
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new ManifestOverlayError('services must be a mapping');
    out.services = {};
    for (const [name, v] of Object.entries(s as Record<string, unknown>)) {
      if (!name || name.length > ITEM_MAX) throw new ManifestOverlayError('services: bad template name');
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some((k) => k !== 'tools')) {
        throw new ManifestOverlayError(`services.${name} must be { tools }`);
      }
      out.services[name] = { tools: parseOps((v as Record<string, unknown>)['tools'], `services.${name}.tools`) };
    }
  }
  return out;
}

/** The app's overlay, or null when it has none. Throws ManifestOverlayError on an unreadable or invalid file. */
export function readManifestOverlay(overlayAppsDir: string, appId: string): ManifestOverlay | null {
  const path = manifestOverlayPath(overlayAppsDir, appId);
  if (!existsSync(path)) return null;
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(path, 'utf-8')); }
  catch (err) { throw new ManifestOverlayError(`${path}: ${(err as Error).message}`); }
  try { return parseManifestOverlay(doc); }
  catch (err) { throw new ManifestOverlayError(`${path}: ${(err as Error).message}`); }
}

const isEmptyOps = (o: OverlayListOps | undefined): boolean => !o || (o.add.length === 0 && o.remove.length === 0);

/** Drop empty op lists and templates; null when nothing is left. */
export function normalizeManifestOverlay(o: ManifestOverlay): ManifestOverlay | null {
  const out: ManifestOverlay = { v: 1 };
  if (!isEmptyOps(o.tools)) out.tools = o.tools!;
  if (!isEmptyOps(o.permissions)) out.permissions = o.permissions!;
  const services = Object.entries(o.services ?? {}).filter(([, s]) => !isEmptyOps(s.tools));
  if (services.length) out.services = Object.fromEntries(services.sort(([a], [b]) => a.localeCompare(b)));
  return out.tools || out.permissions || out.services ? out : null;
}

/** Write (atomically) or, when empty, delete the app's overlay. */
export function writeManifestOverlay(overlayAppsDir: string, appId: string, overlay: ManifestOverlay): void {
  const path = manifestOverlayPath(overlayAppsDir, appId);
  const doc = normalizeManifestOverlay(overlay);
  if (!doc) { rmSync(path, { force: true }); return; }
  mkdirSync(overlayAppsDir, { recursive: true });
  const tmp = `${path}.aura-new-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o644 });
  renameSync(tmp, path);
}

function applyOps(base: unknown, ops: OverlayListOps | undefined): string[] | undefined {
  const list = Array.isArray(base) ? (base as unknown[]).filter((x): x is string => typeof x === 'string') : undefined;
  if (!ops) return list;
  const kept = (list ?? []).filter((x) => !ops.remove.includes(x));
  for (const a of ops.add) if (!kept.includes(a)) kept.push(a);
  // A list the base did not declare appears once the overlay holds an op for it.
  return list === undefined && ops.add.length === 0 && ops.remove.length === 0 ? undefined : kept;
}

/**
 * The manifest (raw JSON, before schema parsing) with the overlay applied. Returns a new object;
 * the input is not changed.
 */
export function applyManifestOverlay<T extends Record<string, unknown>>(manifest: T, overlay: ManifestOverlay | null): T {
  if (!overlay) return manifest;
  const out: Record<string, unknown> = { ...manifest };
  const tools = applyOps(manifest['tools'], overlay.tools);
  if (tools !== undefined) out['tools'] = tools;
  const perms = applyOps(manifest['permissions'], overlay.permissions);
  if (perms !== undefined) out['permissions'] = perms;
  if (overlay.services && Array.isArray(manifest['services'])) {
    out['services'] = (manifest['services'] as unknown[]).map((s) => {
      if (!s || typeof s !== 'object') return s;
      const svc = s as Record<string, unknown>;
      const ops = overlay.services![String(svc['name'])]?.tools;
      if (!ops) return s;
      const t = applyOps(svc['tools'], ops);
      return t === undefined ? s : { ...svc, tools: t };
    });
  }
  return out as T;
}

/** One list's item made present (`want`) or absent, relative to the base. */
function setItem(ops: OverlayListOps, base: readonly string[], item: string, want: boolean): OverlayListOps {
  const add = ops.add.filter((x) => x !== item);
  const remove = ops.remove.filter((x) => x !== item);
  if (want && !base.includes(item)) add.push(item);
  if (!want && base.includes(item)) remove.push(item);
  return { add, remove };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Apply one grant change to an app's overlay, relative to its base manifest (the installed
 * `app.manifest.json`). `changed` compares the effective manifests before and after; an edit
 * that changes nothing returns the overlay as it was.
 */
export function editManifestOverlay(
  overlay: ManifestOverlay | null, base: Record<string, unknown>, edit: OverlayEdit,
): { overlay: ManifestOverlay; changed: boolean } {
  const cur: ManifestOverlay = overlay ?? { v: 1 };
  const before = applyManifestOverlay(base, cur);
  const next: ManifestOverlay = { ...cur };
  const empty: OverlayListOps = { add: [], remove: [] };

  switch (edit.action) {
    case 'add-tool':
    case 'remove-tool': {
      const want = edit.action === 'add-tool';
      if (strings(before['tools']).includes(edit.tool) === want) return { overlay: cur, changed: false };
      next.tools = setItem(cur.tools ?? empty, strings(base['tools']), edit.tool, want);
      break;
    }
    case 'set-tools': {
      const eff = strings(before['tools']);
      const wanted = [...new Set(edit.tools)];
      if (sameSet(eff, wanted)) return { overlay: cur, changed: false };
      let ops = cur.tools ?? empty;
      for (const t of eff) if (!wanted.includes(t)) ops = setItem(ops, strings(base['tools']), t, false);
      for (const t of wanted) if (!eff.includes(t)) ops = setItem(ops, strings(base['tools']), t, true);
      next.tools = ops;
      break;
    }
    case 'add-permission':
    case 'remove-permission': {
      const want = edit.action === 'add-permission';
      if (strings(before['permissions']).includes(edit.permission) === want) return { overlay: cur, changed: false };
      next.permissions = setItem(cur.permissions ?? empty, strings(base['permissions']), edit.permission, want);
      break;
    }
    case 'add-service-tool':
    case 'remove-service-tool': {
      const want = edit.action === 'add-service-tool';
      const find = (m: Record<string, unknown>) => (Array.isArray(m['services']) ? m['services'] as Array<Record<string, unknown>> : [])
        .find((s) => s?.['name'] === edit.service);
      const effSvc = find(before);
      if (!effSvc) throw new ManifestOverlayError(`no services[] template '${edit.service}'`);
      if (strings(effSvc['tools']).includes(edit.tool) === want) return { overlay: cur, changed: false };
      const baseSvc = find(base);
      const prev = cur.services?.[edit.service]?.tools ?? empty;
      let ops = setItem(prev, strings(baseSvc?.['tools']), edit.tool, want);
      // A template the base gives no `tools` keeps its own (empty) list once it had one: the
      // remove stays recorded, so its sidecars keep their own dir (runtime grants).
      if (!want && !Array.isArray(baseSvc?.['tools'])) ops = { ...ops, remove: [...ops.remove, edit.tool] };
      next.services = { ...(cur.services ?? {}), [edit.service]: { tools: ops } };
      break;
    }
  }
  return { overlay: normalizeManifestOverlay(next) ?? { v: 1 }, changed: true };
}

/** Merge two overlays' ops (the second wins per item): the one-shot migration onto an existing overlay. */
export function mergeManifestOverlays(a: ManifestOverlay | null, b: ManifestOverlay): ManifestOverlay {
  const merge = (x: OverlayListOps | undefined, y: OverlayListOps | undefined): OverlayListOps | undefined => {
    if (!y) return x;
    const add = [...(x?.add ?? []).filter((i) => !y.remove.includes(i)), ...y.add];
    const remove = [...(x?.remove ?? []).filter((i) => !y.add.includes(i)), ...y.remove];
    return { add: [...new Set(add)], remove: [...new Set(remove)] };
  };
  const out: ManifestOverlay = { v: 1 };
  const tools = merge(a?.tools, b.tools); if (tools) out.tools = tools;
  const perms = merge(a?.permissions, b.permissions); if (perms) out.permissions = perms;
  const names = new Set([...Object.keys(a?.services ?? {}), ...Object.keys(b.services ?? {})]);
  if (names.size) {
    out.services = {};
    for (const n of names) {
      const t = merge(a?.services?.[n]?.tools, b.services?.[n]?.tools);
      if (t) out.services[n] = { tools: t };
    }
  }
  return normalizeManifestOverlay(out) ?? { v: 1 };
}

/** The ops that turn the `base` manifest's grants into `local`'s (the one-shot migration). */
export function overlayFromDiff(base: Record<string, unknown>, local: Record<string, unknown>): ManifestOverlay | null {
  const diff = (b: unknown, l: unknown): OverlayListOps => {
    const bl = strings(b), ll = strings(l);
    return { add: ll.filter((x) => !bl.includes(x)), remove: bl.filter((x) => !ll.includes(x)) };
  };
  const out: ManifestOverlay = { v: 1, tools: diff(base['tools'], local['tools']), permissions: diff(base['permissions'], local['permissions']) };
  const bs = Array.isArray(base['services']) ? base['services'] as Array<Record<string, unknown>> : [];
  const ls = Array.isArray(local['services']) ? local['services'] as Array<Record<string, unknown>> : [];
  for (const l of ls) {
    const b = bs.find((s) => s?.['name'] === l?.['name']);
    if (!b) continue;
    const ops = diff(b['tools'], l['tools']);
    // A template that gained its own (possibly empty) list where the base had none.
    if (!Array.isArray(b['tools']) && Array.isArray(l['tools']) && ops.add.length === 0) continue;
    (out.services ??= {})[String(l['name'])] = { tools: ops };
  }
  return normalizeManifestOverlay(out);
}
