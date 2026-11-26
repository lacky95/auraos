/**
 * `/api/admin/cap` and `/api/admin/cap-registry` (SF-2): installing shared
 * toolchain capabilities as root in the master, and the owner's own
 * capability definitions.
 *
 * Trust: a request names a capability; it never carries a definition (a body
 * with `entry` is refused). Definitions come from
 *   - the release tree's `.aura/capabilities.yaml` (origin `release`): the
 *     same trust as the shell's own code; or
 *   - an entry the owner approved when it was added (origin `owner`,
 *     core CapabilityRegistryStore: sealed, digest-bound). It cannot shadow a
 *     release entry.
 * Both are validated (core capabilities/definition.ts) and run as argv or fs
 * work only (lib/capabilityInstall.ts).
 *
 * Every install, update, remove, registry add and registry remove is an owner
 * action at `fresh` (the password; D50 `ownerAction`: the desktop owner and
 * the host operator act directly), bound to the operation, the name and the
 * digest of exactly the definition that runs; and audited.
 *
 *   GET  /api/admin/cap                  → { statePath, state, registry }
 *   POST /api/admin/cap {action, name, force?}
 *   GET  /api/admin/cap-registry         → { entries }   (the owner's)
 *   POST /api/admin/cap-registry {name, definition}
 *   DELETE /api/admin/cap-registry?name=<name>
 */
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import * as core from '@aura/core';
import type { CapabilityDefinition, CapabilityRegistryStore } from '@aura/core';
import { json } from './approvals/service.ts';
import { auditPrivileged, livePrivilegedDeps, privilegedAction, UNVERIFIED_HINT, UNVERIFIED_RE, type PrivilegedDeps } from './privilegedExec.ts';
import { liveCapabilityInstaller, STATE_PATH, type CapabilityInstaller } from './capabilityInstall.ts';

export const CAP_OPS = {
  install: 'capability.install',
  remove: 'capability.remove',
  registryAdd: 'capability.registry-add',
  registryRemove: 'capability.registry-remove',
} as const;

export type CapabilityOrigin = 'release' | 'owner';
export interface ResolvedCapability { name: string; definition: CapabilityDefinition; origin: CapabilityOrigin; digest: string }

type Ctx = Parameters<PrivilegedDeps['ownerAction']>[0];

export interface CapabilityDeps extends PrivilegedDeps {
  /** The release tree's registry, validated; throws on an invalid file. */
  releaseRegistry(): Record<string, CapabilityDefinition>;
  store: Pick<CapabilityRegistryStore, 'list' | 'put' | 'remove'>;
  installer: CapabilityInstaller;
  /** After an install: mirror the toolchain and hot-refresh `*`/`#` apps; the instances refreshed. */
  refresh(): string[];
}

/** The release tree's registry file (the CLI reads the same path). */
export const RELEASE_REGISTRY_PATH = process.env['AURA_REGISTRY_PATH'] ?? '/workspace/.aura/capabilities.yaml';

export function readReleaseRegistry(path = RELEASE_REGISTRY_PATH): Record<string, CapabilityDefinition> {
  if (!existsSync(path)) return {};
  return core.parseCapabilityRegistry(parseYaml(readFileSync(path, 'utf-8')));
}

export function liveCapabilityDeps(): CapabilityDeps {
  const priv = livePrivilegedDeps();
  return {
    ...priv,
    releaseRegistry: () => readReleaseRegistry(),
    store: core.getAuthServices().capabilityRegistry,
    installer: liveCapabilityInstaller(priv.run),
    refresh: () => {
      const mgr = core.getAppManager();
      // Push the freshly installed binary into the toolchain mirror BEFORE
      // refreshing any allowlist: allowlist entries are hardlinks FROM the mirror.
      mgr.syncToolchainMirror();
      // Hot-refresh every running app whose tool set tracks what's installed
      // (`*` and `#`). Explicit-list apps get it with `aura cap grant`.
      return mgr.refreshWildcardApps();
    },
  };
}

/** Every capability a request may name: the release's, then the owner's (never shadowing a release name). */
export async function resolveRegistry(deps: Pick<CapabilityDeps, 'releaseRegistry' | 'store'>): Promise<Record<string, ResolvedCapability>> {
  const out: Record<string, ResolvedCapability> = {};
  for (const [name, definition] of Object.entries(deps.releaseRegistry())) {
    out[name] = { name, definition, origin: 'release', digest: core.capabilityDigest(name, definition) };
  }
  for (const [name, e] of Object.entries(await deps.store.list())) {
    if (!out[name]) out[name] = { name, definition: e.definition, origin: 'owner', digest: e.digest };
  }
  return out;
}

/** What the owner reads in the approval dialog: every source, download and write, exactly. */
export function describeDefinition(def: CapabilityDefinition): string[] {
  const lines = [`Source: ${def.source}${def.package ? ` ${def.package}` : ''}`];
  for (const s of def.steps ?? []) {
    if ('apt' in s) lines.push(`apt (verified): ${s.apt.join(', ')}`);
    else if ('download' in s) lines.push(`Download ${s.download.url} (sha256 ${s.download.sha256.slice(0, 12)}…) → ${s.download.to}`);
    else if ('extract' in s) lines.push(`Unpack ${s.extract.url} (sha256 ${s.extract.sha256.slice(0, 12)}…) → ${s.extract.to}`);
    else if ('deb' in s) lines.push(`Install .deb ${s.deb.url} (sha256 ${s.deb.sha256.slice(0, 12)}…)`);
    else if ('file' in s) lines.push(`Write ${s.file.path} (${s.file.mode})`);
    else if ('symlink' in s) lines.push(`Link ${s.symlink.path} → ${s.symlink.target}`);
    else if ('mkdir' in s) lines.push(`Create ${s.mkdir.join(', ')}`);
    else if ('readable' in s) lines.push(`Make readable ${s.readable}`);
  }
  if (def.binary_path) lines.push(`Binary: ${def.binary_path}`);
  return lines;
}

const CAP_BODY = new Set(['action', 'name', 'force']);

async function readJson(ctx: Ctx): Promise<{ body: Record<string, unknown> } | { error: Response }> {
  const text = await ctx.request.text();
  if (text.trim() === '') return { body: {} };
  try {
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('shape');
    return { body: body as Record<string, unknown> };
  } catch {
    return { error: json({ error: 'invalid-request', message: 'body must be a JSON object' }, 400) };
  }
}

export async function getCapabilities(deps: CapabilityDeps = liveCapabilityDeps()): Promise<Response> {
  let registry: Record<string, ResolvedCapability>;
  try { registry = await resolveRegistry(deps); }
  catch (err) { return json({ error: 'registry-invalid', message: (err as Error).message }, 500); }
  return json({ statePath: STATE_PATH, state: deps.installer.loadState(), registry });
}

export async function postCapability(ctx: Ctx, deps: CapabilityDeps = liveCapabilityDeps()): Promise<Response> {
  const read = await readJson(ctx);
  if ('error' in read) return read.error;
  const { body } = read;
  if ('entry' in body) {
    return json({ error: 'definition-not-accepted', message: 'A request names a capability; its definition comes from the registry. Update the aura CLI.' }, 400);
  }
  const extra = Object.keys(body).filter((k) => !CAP_BODY.has(k));
  if (extra.length) return json({ error: 'invalid-request', message: `unknown field: ${extra.join(', ')}` }, 400);
  const action = body['action'] ?? 'install';
  if (action !== 'install' && action !== 'remove') return json({ error: 'invalid-request', message: 'action must be install or remove' }, 400);
  const name = body['name'];
  if (typeof name !== 'string' || !core.CAPABILITY_NAME_RE.test(name)) return json({ error: 'invalid-request', message: '`name` must be a capability name' }, 400);
  if (body['force'] !== undefined && typeof body['force'] !== 'boolean') return json({ error: 'invalid-request', message: '`force` must be true or false' }, 400);
  const force = body['force'] === true;

  let cap: ResolvedCapability | undefined;
  try { cap = (await resolveRegistry(deps))[name]; }
  catch (err) { return json({ error: 'registry-invalid', message: (err as Error).message }, 500); }
  if (!cap) return json({ error: 'unknown-capability', message: `${name} is not in the capability registry` }, 404);

  const operation = action === 'install' ? CAP_OPS.install : CAP_OPS.remove;
  const actor = await privilegedAction(deps, ctx, {
    operation, bind: { name, origin: cap.origin, digest: cap.digest, ...(action === 'install' ? { force } : {}) }, level: 'fresh',
    title: `${action === 'install' ? 'Install' : 'Remove'} the capability ${name}`,
    details: [
      `From the ${cap.origin === 'release' ? 'release registry' : 'capabilities you added'} (digest ${cap.digest.slice(0, 12)}…)`,
      ...describeDefinition(cap.definition),
      action === 'install' ? 'Runs as root in the master; the tool lands in the shared toolchain.' : 'Removes it from the shared toolchain.',
    ],
  });
  if (actor instanceof Response) return actor;

  const target = `capability:${name}`;
  const detail = { name, origin: cap.origin, digest: cap.digest, ...(action === 'install' ? { force } : {}) };
  const state = deps.installer.loadState();
  try {
    if (action === 'remove') {
      deps.installer.remove(name, cap.definition);
      delete state.capabilities[name];
      deps.installer.saveState(state);
      await auditPrivileged(deps, actor, operation, { target, outcome: 'ok', detail });
      return json({ ok: true, action, name });
    }
    const result = await deps.installer.install(name, cap.definition, force);
    state.capabilities[name] = { installed: true, installedAt: new Date().toISOString(), version: result.version };
    deps.installer.saveState(state);
    const refreshed = deps.refresh();
    await auditPrivileged(deps, actor, operation, { target, outcome: 'ok', detail: { ...detail, version: result.version } });
    return json({
      ok: true, action, name,
      symlink: result.symlink,
      version: result.version,
      libsCopied: result.libsCopied,
      // Named, not just counted: the CLI reports these like sidecars, so a
      // multi-file install is visible. `libsMissing` is installed-but-unrunnable.
      libs: result.libs.filter((d) => d.kind === 'staged').map((d) => d.soname),
      libsMissing: result.libs.filter((d) => d.kind === 'missing').map((d) => d.soname),
      sidecars: result.sidecars,
      refreshed,
    });
  } catch (err) {
    const message = (err as Error).message;
    await auditPrivileged(deps, actor, operation, { target, outcome: 'failed', detail, error: message });
    return json({ error: message, ...(UNVERIFIED_RE.test(message) ? { hint: UNVERIFIED_HINT } : {}) }, 500);
  }
}

// ── the owner's capability definitions ──────────────────────────────────────

export async function getCapabilityRegistry(deps: CapabilityDeps = liveCapabilityDeps()): Promise<Response> {
  return json({ entries: await deps.store.list() });
}

export async function postCapabilityRegistry(ctx: Ctx, deps: CapabilityDeps = liveCapabilityDeps()): Promise<Response> {
  const read = await readJson(ctx);
  if ('error' in read) return read.error;
  const { body } = read;
  const extra = Object.keys(body).filter((k) => k !== 'name' && k !== 'definition');
  if (extra.length) return json({ error: 'invalid-request', message: `unknown field: ${extra.join(', ')}` }, 400);
  const name = body['name'];
  if (typeof name !== 'string') return json({ error: 'invalid-request', message: '`name` is required' }, 400);
  let definition: CapabilityDefinition;
  try { definition = core.parseCapabilityDefinition(name, body['definition']); }
  catch (err) { return json({ error: 'invalid-definition', message: (err as Error).message }, 400); }
  let release: Record<string, CapabilityDefinition>;
  try { release = deps.releaseRegistry(); }
  catch (err) { return json({ error: 'registry-invalid', message: (err as Error).message }, 500); }
  if (release[name]) return json({ error: 'release-capability', message: `${name} is defined by the release registry; pick another name` }, 409);

  const digest = core.capabilityDigest(name, definition);
  const actor = await privilegedAction(deps, ctx, {
    operation: CAP_OPS.registryAdd, bind: { name, digest }, level: 'fresh',
    title: `Add the capability ${name} to the registry`,
    details: [`Digest ${digest.slice(0, 12)}…`, ...describeDefinition(definition), 'Installing it later asks you again.'],
  });
  if (actor instanceof Response) return actor;
  const approval = typeof actor.detail['approval'] === 'string' ? actor.detail['approval'] : undefined;
  const r = await deps.store.put(name, definition, approval ? { approval } : {});
  if (!r.ok) return json({ error: 'conflict', message: 'The registry changed meanwhile. Try again.' }, 409);
  await auditPrivileged(deps, actor, CAP_OPS.registryAdd, { target: `capability:${name}`, outcome: 'ok', detail: { name, digest, changed: r.changed } });
  return json({ ok: true, name, digest, changed: r.changed });
}

export async function deleteCapabilityRegistry(ctx: Ctx, deps: CapabilityDeps = liveCapabilityDeps()): Promise<Response> {
  const name = new URL(ctx.request.url).searchParams.get('name');
  if (typeof name !== 'string' || !core.CAPABILITY_NAME_RE.test(name)) return json({ error: 'invalid-request', message: '`?name=` must be a capability name' }, 400);
  const entry = (await deps.store.list())[name];
  if (!entry) return json({ error: 'not-found', message: `${name} is not one of the capabilities you added` }, 404);
  const actor = await privilegedAction(deps, ctx, {
    operation: CAP_OPS.registryRemove, bind: { name, digest: entry.digest }, level: 'fresh',
    title: `Remove the capability ${name} from the registry`,
    details: [`Digest ${entry.digest.slice(0, 12)}…`, 'An installed copy stays until `aura cap remove`.'],
  });
  if (actor instanceof Response) return actor;
  const r = await deps.store.remove(name);
  if (!r.ok) return json({ error: 'conflict', message: 'The registry changed meanwhile. Try again.' }, 409);
  await auditPrivileged(deps, actor, CAP_OPS.registryRemove, { target: `capability:${name}`, outcome: 'ok', detail: { name, digest: entry.digest } });
  return json({ ok: true, name });
}
