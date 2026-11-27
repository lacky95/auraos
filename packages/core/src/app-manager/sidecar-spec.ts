import { createHash } from 'node:crypto';
import type { AppManifest } from '../types/manifest.js';
import type { AuraErrorBody } from '../errors/contracts.js';
import { SHARED_HOME_PATH } from './tool-provision.js';
import { isEnvValueRef, type EnvValue } from '../types/setupManifest.js';

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
  /**
   * Initial runtime tool grants (plain names or `'*'`, no `'#'`): added to
   * the sidecar's runtime grants, intersected with the app's tools[] like
   * every grant, NOT part of the spec (adopting merges them in). Needs
   * `sidecars.tools` and a template that declares `tools` (409 otherwise).
   */
  tools?: string[];
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
  /**
   * D107: on its instance's own network only (`services[].network`, default
   * `instance` for an inheritHome sidecar). Present only when set, like
   * `inheritHome`: a `shared` sidecar's spec hash is unchanged.
   */
  network?: 'instance';
  /**
   * D108: env variables whose value is a setup SECRET, by reference only
   * (field, vault handle). The value is read server-side when the container
   * is created (SidecarManager) and goes only into its env: never into this
   * spec, its hash, the record label or an error. Present only when set, so
   * every other spec hash is unchanged.
   */
  secretEnv?: Record<string, SecretEnvRef>;
  mounts: { own: boolean; inherit: boolean; exclude: string[]; forceRo: boolean };
}

/** A secret env variable by reference: the setup field and the app's vault handle. */
export interface SecretEnvRef { field: string; handle: string }

/**
 * D108 value delivery, handed in through the context (setup/values.ts
 * `sidecarSetupValues` over the app's effective configuration): turns a
 * template's env into literals (`fromSetup`, mapped) and secret references
 * (`fromSecret`). Throws when a value can't be delivered (never a raw or
 * empty value instead).
 */
export interface SpecEnvResolver {
  env(template: string, env: Record<string, EnvValue>): { env: Record<string, string>; secretEnv: Record<string, SecretEnvRef> };
}

/**
 * D108 value delivery for one spawn (SidecarManager opts.setupValues;
 * setup/values.ts `sidecarSetupValues`): the env resolver and the
 * server-side read of the app's own secret handles.
 */
export interface SidecarSetupValues extends SpecEnvResolver {
  /** The value behind the app's handle, or null when it is not the app's to read. Never logged. */
  readSecret(handle: string): Promise<string | null>;
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
  /**
   * D108: the resolver of setup references in the template's env, present
   * only when the app has an effective configuration (`ready`). Without it a
   * reference refuses the sidecar (fail closed).
   */
  setupEnv?: SpecEnvResolver;
}

export class SpecError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * B12 (D107): an `inheritHome` sidecar runs as its app's identity; a template
 * `user` that conflicts with it is refused, never honoured and never
 * overridden silently. The D105 body (errors/contracts.ts) travels with it.
 */
export class SidecarIdentityError extends SpecError {
  readonly code = 'sidecar-identity-conflict';
  readonly body: AuraErrorBody;
  constructor(appId: string, template: string, user: string, appUser: string | null) {
    const message = `template '${template}' sets user '${user}' and inheritHome: a sidecar with ${appId}'s home runs as `
      + (appUser ? `the app's identity (${appUser})` : 'the app\'s own user (a root installation: its image user, without capabilities)')
      + ', so it is not created';
    super(409, message);
    this.name = 'SidecarIdentityError';
    this.body = {
      error: this.code, message, category: 'invalid-request',
      manifestField: `services[${template}].user`,
      hint: `drop "user" from services[${template}] in app.manifest.json (an inheritHome sidecar always runs as its app's identity)`,
    };
  }
}

export const SIDECAR_NAME_RE = /^[a-z][a-z0-9-]{0,47}$/;
const ALLOWED_KEYS = new Set(['template', 'name', 'suffix', 'image', 'env', 'envInherit', 'command', 'mounts', 'tools', 'replace', 'takeover', 'wait']);

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
  str('name'); str('suffix'); str('image'); strArr('envInherit'); strArr('command'); strArr('tools');
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
  if (tpl.inheritDockerSocket) {
    // Stream J.7 (D54/D55): no sidecar gets the Docker socket; OS sidecars (sidecars.spawn) replace it.
    throw new SpecError(403, `template '${tpl.name}' sets inheritDockerSocket: no sidecar gets the Docker socket any more (use OS sidecars, permission sidecars.spawn)`);
  }

  if (req.tools?.length && !tpl.tools) {
    throw new SpecError(409, `template '${tpl.name}' declares no tools — a sidecar of it has no tools dir of its own to grant into. Declare \`"tools": []\` (or a list) in that services[] entry`);
  }
  if (tpl.tools && tpl.inheritTools) {
    throw new SpecError(400, `template '${tpl.name}' sets both tools and inheritTools — use tools (its own subset of the app's tools) or inheritTools (the app's whole set), not both`);
  }
  // Own tools are a tool grant to the sidecar — template-declared or not, the
  // app must hold the permission. (inheritTools shares the app's own dir and
  // needs nothing extra.)
  if (tpl.tools && !ctx.can('sidecars.tools')) {
    throw new SpecError(403, `template '${tpl.name}' declares tools — ${ctx.appId} needs 'sidecars.tools' to grant tools to its sidecars (aura grant perms ${ctx.appId} sidecars.tools)`);
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

  const tplEnv = templateEnv(tpl.name, tpl.env ?? {}, ctx.setupEnv);
  // The request wins over the template, also over a secret reference.
  const secretEnv = Object.fromEntries(Object.entries(tplEnv.secretEnv).filter(([k]) => !(req.env && k in req.env)));

  return {
    name,
    template: tpl.name,
    image: req.image ?? tpl.image,
    command: req.command ?? tpl.command ?? [],
    env: { ...tplEnv.env, ...(req.env ?? {}) },
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
    ...((tpl.network ?? (tpl.inheritHome ? 'instance' : 'shared')) === 'instance' ? { network: 'instance' as const } : {}),
    ...(Object.keys(secretEnv).length ? { secretEnv } : {}),
    mounts,
  };
}

/**
 * A template's env: literals, plus secret references. A template without a
 * D108 reference is taken as is (no resolver asked). A reference is resolved
 * through `setupEnv` (the app's effective configuration); without one (the
 * app's setup is not complete) the sidecar is refused instead of started
 * without the value (fail closed, never an empty or raw value).
 */
function templateEnv(template: string, env: Record<string, EnvValue>, setupEnv: SpecEnvResolver | undefined): ReturnType<SpecEnvResolver['env']> {
  const refs = Object.entries(env).filter(([, v]) => isEnvValueRef(v));
  if (!refs.length) return { env: { ...(env as Record<string, string>) }, secretEnv: {} };
  if (!setupEnv) throw new SpecError(409, `template '${template}' env ${refs[0]![0]} references a setup value; it needs the app's completed setup (D108)`);
  try {
    return setupEnv.env(template, env);
  } catch (err) {
    throw new SpecError(409, `template '${template}': ${(err as Error).message}`);
  }
}

/** JSON with object keys sorted at every level — stable across key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Identity of a resolved spec: equal hash → the running container can be
 * adopted as-is. A secret is covered by its reference (`secretEnv`: field and
 * handle), never by its value: the spec holds no secret value.
 */
export function specHash(spec: ResolvedSidecarSpec): string {
  // `inheritDockerSocket: false` was part of every spec before the socket
  // went (J.7, stream C): hashed as before, so no existing sidecar is
  // recreated just because the field is gone.
  return createHash('sha256').update(canonical({ ...spec, inheritDockerSocket: false })).digest('hex').slice(0, 16);
}
