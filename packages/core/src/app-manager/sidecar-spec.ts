import { createHash } from 'node:crypto';
import type { AppManifest } from '../types/manifest.js';
import { SHARED_HOME_PATH } from './tool-provision.js';

/**
 * What an app may ask the OS to start, and what it gets. Pure — every rule
 * that decides "is this sidecar allowed, and what exactly does it run" lives
 * here so it can be tested without docker (test/sidecar-spec.test.mjs);
 * SidecarManager only turns the result into docker calls.
 *
 * The containment rules:
 *   • A sidecar is a `services[]` TEMPLATE of the calling app. A request may
 *     override only name/suffix, env, envInherit, command and mounts. Any
 *     other image needs `sidecars.anyImage`.
 *   • `privileged` / `capabilities` / `devices` / `publish` need
 *     `sidecars.privileged` — even when the app's own template declares them:
 *     the manifest is app-authored, and the OS path must not become a route to
 *     privilege for an app that holds no docker socket.
 *   • The docker socket is forwarded only if the app itself holds the
 *     `docker` tool (a sibling never exceeds its app).
 *   • Volumes live in the app's own data area. `volume` / `subpath`
 *     overrides (which can point anywhere) stay SDK-path only.
 */

export type ServiceTemplate = AppManifest['services'][number];

export interface SidecarMountsRequest {
  /** The sidecar gets its own mount root and may receive mounts of its own. */
  own?: boolean;
  /**
   * Mirror the app's cross-app mounts into the sidecar (live). Default: the
   * template's `inheritMounts`. `exclude` drops mount ids; `mode: 'ro'` caps
   * every inherited mount at read-only.
   */
  inherit?: boolean | { exclude?: string[]; mode?: 'ro' };
}

export interface SidecarSpawnRequest {
  /** `services[].name` of the calling app. */
  template: string;
  /** Full sidecar name (default: the template name). */
  name?: string;
  /** Sidecar name = `<template>-<suffix>`. Exclusive with `name`. */
  suffix?: string;
  /** Free image instead of the template's — needs `sidecars.anyImage`. */
  image?: string;
  /** Merged over the template's env (request wins). */
  env?: Record<string, string>;
  /** Extra names to inherit, merged with the template's list. */
  envInherit?: string[];
  /** Replaces the template's command. */
  command?: string[];
  mounts?: SidecarMountsRequest;
  /** When a sidecar of that name runs with a DIFFERENT spec: recreate it (default true) or 409. */
  replace?: boolean;
  /**
   * Adopt-by-removal of an app-managed container of the same name owned by
   * the same instance (migrating from the SDK docker path). Default false → 409.
   */
  takeover?: boolean;
  /**
   * Answer only once the sidecar is up: `port` — its port accepts TCP;
   * `ready` — the template's `readiness.path` answers HTTP (falls back to the
   * port when the template declares no readiness).
   */
  wait?: { port?: boolean; ready?: boolean; timeoutMs?: number };
}

export interface ResolvedVolume {
  name: string;
  target: string;
  /** Docker volume name. */
  source: string;
  /** volume-subpath inside `source`; absent for a legacy per-app volume. */
  subpath?: string;
}

export interface ResolvedSidecarSpec {
  name: string;
  template: string;
  image: string;
  command: string[];
  env: Record<string, string>;
  envInherit: string[];
  port?: number;
  restart: 'no' | 'on-failure' | 'always' | 'unless-stopped';
  dns: string[];
  user?: string;
  workdir?: string;
  capabilities: string[];
  devices: string[];
  privileged: boolean;
  publish: Array<{ host: number; container: number }>;
  limits?: { memory?: string; cpus?: number };
  seed?: { command: string[] };
  readiness?: { path: string; timeoutMs: number };
  volumes: ResolvedVolume[];
  inheritIdentity: boolean;
  inheritPermissions: boolean;
  inheritTools: boolean;
  /**
   * Present only when the template asks for it — an absent key keeps the spec
   * hash of every existing sidecar unchanged (no recreate on its next spawn).
   */
  inheritHome?: true;
  /**
   * The template declares `tools`: the sidecar gets its OWN allowlist dir at
   * /aura/my-tools (SidecarManager provisions it — template list ∪ runtime
   * grants, ∩ the app's tools[]). Only the flag is part of the spec: the list
   * is applied live into the mounted dir, so changing it never recreates the
   * container. Present only when set, like `inheritHome`.
   */
  ownTools?: true;
  inheritDockerSocket: boolean;
  mounts: { own: boolean; inherit: boolean; exclude: string[]; forceRo: boolean };
}

export interface ResolveContext {
  appId: string;
  instanceId: string;
  manifest: Pick<AppManifest, 'services' | 'tools'>;
  /** Does the app hold this permission (ENFORCED lookup)? */
  can: (permission: string) => boolean;
  /** App-level data subpath on the app-data volume (`…/apps/<appId>`). */
  appDataSubpath: string;
  appDataVolume: string;
  /** Does the pre-`.sidecars` per-app volume `aura-<appId>-<vol>` exist? (SDK precedence) */
  legacyVolumeExists: (name: string) => boolean;
  /** Does the app's own tools[] grant docker? */
  hasDockerTool: boolean;
}

export class SpecError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const SIDECAR_NAME_RE = /^[a-z][a-z0-9-]{0,47}$/;
const ALLOWED_KEYS = new Set(['template', 'name', 'suffix', 'image', 'env', 'envInherit', 'command', 'mounts', 'replace', 'takeover', 'wait']);

/** Validate the request shape (it arrives as untrusted JSON). */
export function parseSpawnRequest(body: unknown): SidecarSpawnRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SpecError(400, 'body must be a JSON object');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!ALLOWED_KEYS.has(k)) {
      throw new SpecError(400, `'${k}' cannot be set per request — allowed: ${[...ALLOWED_KEYS].join(', ')}. Change the services[] template instead.`);
    }
  }
  const str = (k: string) => { if (b[k] !== undefined && typeof b[k] !== 'string') throw new SpecError(400, `${k} must be a string`); };
  const strArr = (k: string) => {
    if (b[k] !== undefined && (!Array.isArray(b[k]) || !(b[k] as unknown[]).every((x) => typeof x === 'string'))) {
      throw new SpecError(400, `${k} must be an array of strings`);
    }
  };
  if (typeof b['template'] !== 'string' || !b['template']) throw new SpecError(400, 'template is required');
  str('name'); str('suffix'); str('image'); strArr('envInherit'); strArr('command');
  if (b['env'] !== undefined) {
    const env = b['env'];
    if (!env || typeof env !== 'object' || Array.isArray(env) || !Object.values(env).every((v) => typeof v === 'string')) {
      throw new SpecError(400, 'env must be an object of strings');
    }
  }
  if (b['mounts'] !== undefined) {
    const m = b['mounts'] as Record<string, unknown>;
    if (!m || typeof m !== 'object') throw new SpecError(400, 'mounts must be an object');
    if (m['own'] !== undefined && typeof m['own'] !== 'boolean') throw new SpecError(400, 'mounts.own must be a boolean');
    const inh = m['inherit'];
    if (inh !== undefined && typeof inh !== 'boolean') {
      const o = inh as Record<string, unknown>;
      if (!o || typeof o !== 'object') throw new SpecError(400, 'mounts.inherit must be a boolean or { exclude?, mode? }');
      if (o['exclude'] !== undefined && (!Array.isArray(o['exclude']) || !o['exclude'].every((x) => typeof x === 'string'))) {
        throw new SpecError(400, 'mounts.inherit.exclude must be an array of mount ids');
      }
      if (o['mode'] !== undefined && o['mode'] !== 'ro') throw new SpecError(400, "mounts.inherit.mode can only be 'ro'");
    }
  }
  if (b['wait'] !== undefined) {
    const w = b['wait'] as Record<string, unknown>;
    if (!w || typeof w !== 'object' || Array.isArray(w)) throw new SpecError(400, 'wait must be an object');
    for (const k of ['port', 'ready']) if (w[k] !== undefined && typeof w[k] !== 'boolean') throw new SpecError(400, `wait.${k} must be a boolean`);
    if (w['timeoutMs'] !== undefined && (typeof w['timeoutMs'] !== 'number' || w['timeoutMs'] <= 0)) throw new SpecError(400, 'wait.timeoutMs must be a positive number');
  }
  return b as unknown as SidecarSpawnRequest;
}

export function resolveSidecarSpec(req: SidecarSpawnRequest, ctx: ResolveContext): ResolvedSidecarSpec {
  const tpl = (ctx.manifest.services ?? []).find((s) => s.name === req.template);
  if (!tpl) {
    const names = (ctx.manifest.services ?? []).map((s) => s.name);
    throw new SpecError(404, `no services[] template '${req.template}' in ${ctx.appId}${names.length ? ` — templates: ${names.join(', ')}` : ' (it declares none)'}`);
  }
  if (req.name && req.suffix) throw new SpecError(400, 'pass either name or suffix, not both');
  const name = req.name ?? (req.suffix ? `${tpl.name}-${req.suffix}` : tpl.name);
  if (!SIDECAR_NAME_RE.test(name)) {
    throw new SpecError(400, `sidecar name '${name}' must match ${SIDECAR_NAME_RE} (lowercase, digits, '-', ≤ 48 chars)`);
  }

  if (req.image && req.image !== tpl.image && !ctx.can('sidecars.anyImage')) {
    throw new SpecError(403, `${ctx.appId} is not granted 'sidecars.anyImage' — it can only run its services[] templates' images`);
  }

  const privileged = tpl.privileged === true;
  const capabilities = tpl.capabilities ?? [];
  const devices = tpl.devices ?? [];
  const publish = tpl.publish ?? [];
  if ((privileged || capabilities.length || devices.length || publish.length) && !ctx.can('sidecars.privileged')) {
    throw new SpecError(403, `template '${tpl.name}' uses privileged/capabilities/devices/publish — ${ctx.appId} needs 'sidecars.privileged'`);
  }
  if (tpl.inheritDockerSocket && !ctx.hasDockerTool) {
    throw new SpecError(403, `template '${tpl.name}' sets inheritDockerSocket, but ${ctx.appId}'s tools[] does not grant docker — a sidecar never exceeds its app`);
  }

  if (tpl.tools && tpl.inheritTools) {
    throw new SpecError(400, `template '${tpl.name}' sets both tools and inheritTools — use tools (its own subset of the app's tools) or inheritTools (the app's whole set), not both`);
  }
  if (tpl.inheritHome && (tpl.volumes ?? []).some((v) => v.target.replace(/\/+$/, '') === SHARED_HOME_PATH)) {
    throw new SpecError(400, `template '${tpl.name}' sets inheritHome and also mounts a volume at ${SHARED_HOME_PATH} — drop one of them`);
  }
  const volumes: ResolvedVolume[] = (tpl.volumes ?? []).map((v) => {
    if (v.volume || v.subpath) {
      throw new SpecError(400, `template '${tpl.name}' volume '${v.name}' sets volume/subpath — only the SDK docker path supports those (they can point outside the app's data)`);
    }
    // Same precedence as the SDK's resolveVolume, so a template first run by
    // the SDK keeps its data when it moves to the OS path: a pre-existing
    // per-app volume wins, else `<appData>/.sidecars/<owner>/<vol>`.
    const legacy = `aura-${ctx.appId}-${v.name}`;
    if (name === tpl.name && ctx.legacyVolumeExists(legacy)) return { name: v.name, target: v.target, source: legacy };
    const owner = v.shared ? tpl.name : name;
    return { name: v.name, target: v.target, source: ctx.appDataVolume, subpath: `${ctx.appDataSubpath}/.sidecars/${owner}/${v.name}` };
  });

  const inh = req.mounts?.inherit;
  const inherit = inh === undefined ? tpl.inheritMounts === true : inh !== false;
  const mounts = {
    own: req.mounts?.own === true,
    inherit,
    exclude: typeof inh === 'object' ? [...(inh.exclude ?? [])].sort() : [],
    forceRo: typeof inh === 'object' && inh.mode === 'ro',
  };

  return {
    name,
    template: tpl.name,
    image: req.image ?? tpl.image,
    command: req.command ?? tpl.command ?? [],
    env: { ...(tpl.env ?? {}), ...(req.env ?? {}) },
    envInherit: [...new Set([...(tpl.envInherit ?? []), ...(req.envInherit ?? [])])],
    ...(tpl.port !== undefined ? { port: tpl.port } : {}),
    restart: tpl.restart ?? 'unless-stopped',
    dns: tpl.dns ?? [],
    ...(tpl.user ? { user: tpl.user } : {}),
    ...(tpl.workdir ? { workdir: tpl.workdir } : {}),
    capabilities,
    devices,
    privileged,
    publish,
    ...(tpl.limits ? { limits: tpl.limits } : {}),
    ...(tpl.seed ? { seed: tpl.seed } : {}),
    ...(tpl.readiness ? { readiness: { path: tpl.readiness.path ?? '/', timeoutMs: tpl.readiness.timeoutMs ?? 600_000 } } : {}),
    volumes,
    inheritIdentity: tpl.inheritIdentity === true,
    inheritPermissions: tpl.inheritPermissions === true,
    inheritTools: tpl.inheritTools === true,
    ...(tpl.inheritHome ? { inheritHome: true as const } : {}),
    ...(tpl.tools ? { ownTools: true as const } : {}),
    inheritDockerSocket: tpl.inheritDockerSocket === true,
    mounts,
  };
}

/** JSON with object keys sorted at every level — stable across key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Identity of a resolved spec: equal hash → the running container can be adopted as-is. */
export function specHash(spec: ResolvedSidecarSpec): string {
  return createHash('sha256').update(canonical(spec)).digest('hex').slice(0, 16);
}
