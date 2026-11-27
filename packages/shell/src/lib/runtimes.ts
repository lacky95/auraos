/**
 * `/api/admin/runtimes/**` (Phase 5 stream R, ARI §5.1, §9.7, D75): the
 * runtime registry and the Runtime Settings record (`user:policy:runtimes`).
 *
 *   GET    /api/admin/runtimes                        every runtime (capabilities, health, settings and
 *                                                     their schema, instances), every installation's
 *                                                     resolution and its source, the overrides, the open
 *                                                     D75 decisions
 *   PUT    /api/admin/runtimes/default    {runtime}   the default for apps that name none
 *   PUT    /api/admin/runtimes/:id/settings {…}       settings, validated against the runtime's schema
 *   POST   /api/admin/runtimes/:id/enable|disable     disable: refused while instances run unless
 *                                                     `{stopInstances: true}` (they are stopped)
 *   DELETE /api/admin/runtimes/overrides/:installationId   remove an override (applies at the next start)
 *   POST   /api/admin/runtimes/migrate {appId, decision: 'adopt-default'|'keep', runtime?}  a D75 decision
 *   POST   /api/admin/runtimes/check {runtime, appId?, needs?}  a read-only capability dry run (diagnose)
 *
 * Reads are the owner's (the route manifest's OWNER rule: the desktop,
 * Settings, the trusted System Terminal); nothing secret is in them. Every
 * change is an owner action at `fresh` (the password, or the host
 * operator), compare-and-set, and audited (`runtime.*`). A change applies to
 * the next start of an app; running instances keep their latched runtime.
 */
import * as core from '@aura/core';
import type { RuntimeCapabilities, RuntimeSettingsRecord } from '@aura/core';
import { auditOwner, ownerAction, type OwnerActor } from './approvals/admin.ts';
import { json } from './approvals/service.ts';

type Ctx = Parameters<typeof ownerAction>[0];
type Mgr = ReturnType<typeof core.getAppManager>;

export interface RuntimesDeps {
  ownerAction(ctx: Ctx, req: Parameters<typeof ownerAction>[1]): Promise<OwnerActor | Response>;
  audit(actor: OwnerActor, action: string, opts: Parameters<typeof auditOwner>[2]): Promise<void>;
  mgr: Pick<Mgr, 'runtimes' | 'runtimeSettings' | 'runtimeApps' | 'getAllInstances' | 'stop'>;
  env: Record<string, string | undefined>;
}

export function liveRuntimesDeps(): RuntimesDeps {
  return {
    ownerAction: (ctx, req) => ownerAction(ctx, req),
    audit: (actor, action, opts) => auditOwner(actor, action, opts),
    mgr: core.getAppManager(),
    env: process.env,
  };
}

const A = core.RUNTIME_AUDIT_ACTIONS;

async function readBody(ctx: Ctx): Promise<Record<string, unknown> | Response> {
  try {
    const b = await ctx.request.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : json({ error: 'invalid-request', message: 'body must be a JSON object' }, 400);
  } catch { return json({ error: 'invalid-request', message: 'body must be JSON' }, 400); }
}

function errorResponse(err: unknown): Response {
  if (err instanceof core.RuntimeChangeError) {
    const status = err.code === 'not-found' ? 404 : err.code === 'unknown-runtime' ? 404 : err.code === 'invalid-settings' ? 400 : 409;
    return json({ error: err.code, message: err.message }, status);
  }
  throw err;
}

const conflict = () => json({ error: 'conflict', message: 'The Runtime Settings changed meanwhile. Try again.' }, 409);

/** The resolution of every installed app, as a start would see it now (no side effects). */
async function installations(deps: RuntimesDeps, record: RuntimeSettingsRecord) {
  const apps = await deps.mgr.runtimeApps();
  return apps.map((a) => {
    const row = { appId: a.appId, installationId: a.installationId, sandbox: (a.manifest.sandbox ? 'explicit' : 'omitted') as 'explicit' | 'omitted', sourceMode: a.sourceMode };
    try {
      const r = deps.mgr.runtimes.resolve({ manifest: a.manifest, installationId: a.installationId, sourceMode: a.sourceMode, record });
      return { ...row, runtime: r.runtime, source: r.source };
    } catch (err) {
      let chosen: { runtime: string; source: string } | null = null;
      try { chosen = deps.mgr.runtimes.choose({ manifest: a.manifest, installationId: a.installationId, record }); } catch { /* the error says why */ }
      const e = err as Error & { code?: string };
      return { ...row, runtime: chosen?.runtime ?? null, source: chosen?.source ?? null, error: { code: e.code ?? 'error', message: e.message } };
    }
  });
}

/** GET: the whole picture for Settings → Runtimes, `aura runtime ls|show` and diagnose. */
export async function getRuntimes(_ctx: Ctx, deps: RuntimesDeps = liveRuntimesDeps()): Promise<Response> {
  const { record, trusted } = await deps.mgr.runtimeSettings.read();
  const instances = deps.mgr.getAllInstances();
  const runtimes = deps.mgr.runtimes.list().map((m) => {
    const id = m.descriptor.id;
    const state = deps.mgr.runtimes.settingsState(id, record);
    const settings = state.ok ? state.settings : core.settingsDefaults(m.descriptor.settingsSchema);
    const health = deps.mgr.runtimes.healthOf(id, record);
    const refusal = core.healthRefusal(health);
    return {
      id, title: m.descriptor.title, description: m.descriptor.description, builtIn: m.descriptor.builtIn,
      version: m.descriptor.version, ari: m.descriptor.ari, settingsVersion: m.descriptor.settingsVersion,
      alwaysEnabled: Boolean(m.descriptor.alwaysEnabled),
      enabled: deps.mgr.runtimes.isEnabled(id, record),
      isDefault: record.default === id,
      settingsSchema: m.descriptor.settingsSchema,
      settings,
      capabilities: m.capabilities(settings),
      // D100 §12: technical feasibility, derived from the capabilities (never an authorization).
      features: core.moduleFeatures(m, settings),
      // `detail` stays for the clients that read it (Settings, `aura runtime show`); `checks` is the ARI shape.
      health: { status: health.status, checks: health.checks, ...(refusal ? { detail: refusal } : {}) },
      instances: instances.filter((i) => i.sandbox === id && i.state !== 'destroyed')
        .map((i) => ({ instanceId: i.instanceId, appId: i.appId, state: i.state, ...(i.runtimeSource ? { source: i.runtimeSource } : {}) })),
    };
  });
  return json({
    default: record.default,
    trusted,
    useProotEnv: deps.env['AURA_USE_PROOT'] ?? null,
    runtimes,
    installations: await installations(deps, record),
    overrides: Object.entries(record.overrides).map(([installationId, o]) => ({ installationId, ...o })),
    pending: Object.entries(record.pending ?? {}).map(([installationId, p]) => ({ installationId, ...p })),
    migration: { d75: record.migrations?.d75 ?? null },
  });
}

async function act(
  ctx: Ctx, deps: RuntimesDeps, title: string, payload: unknown, details: string[] = [],
): Promise<OwnerActor | Response> {
  return deps.ownerAction(ctx, {
    action: 'admin.change', payload: { runtimes: payload }, level: 'fresh', title,
    details: [...details, 'Applies to the next start of an app; running instances keep their runtime.'],
  });
}

function known(deps: RuntimesDeps, id: unknown): string | Response {
  if (typeof id !== 'string' || !core.RUNTIME_ID_PATTERN.test(id)) return json({ error: 'invalid-request', message: 'a runtime id is required' }, 400);
  if (!deps.mgr.runtimes.get(id)) return json({ error: 'unknown-runtime', message: `runtime ${id} is not installed` }, 404);
  return id;
}

/** PUT default `{runtime}`. */
export async function putDefault(ctx: Ctx, deps: RuntimesDeps = liveRuntimesDeps()): Promise<Response> {
  const body = await readBody(ctx);
  if (body instanceof Response) return body;
  const id = known(deps, body['runtime']);
  if (id instanceof Response) return id;
  const before = await deps.mgr.runtimeSettings.get();
  const actor = await act(ctx, deps, `Default runtime: ${before.default} → ${id}`, { default: id },
    ['Apps that name no runtime (and have no override) start on it.']);
  if (actor instanceof Response) return actor;
  let r;
  try { r = await deps.mgr.runtimeSettings.setDefault(id); } catch (err) { return errorResponse(err); }
  if (!r.ok) return conflict();
  if (r.changed) await deps.audit(actor, A.defaultChanged, { target: `runtime:${id}`, detail: { from: r.previous.default, to: id } });
  return json({ ok: true, changed: r.changed, default: r.record.default });
}

/** PUT :id/settings `{…}`. */
export async function putSettings(ctx: Ctx, id: string | undefined, deps: RuntimesDeps = liveRuntimesDeps()): Promise<Response> {
  const rid = known(deps, id);
  if (rid instanceof Response) return rid;
  const body = await readBody(ctx);
  if (body instanceof Response) return body;
  const input = body['settings'] && typeof body['settings'] === 'object' ? body['settings'] : body;
  // Settings that failed to migrate show as stored; the write replaces them (ARI §4.3).
  const state = deps.mgr.runtimes.settingsState(rid, await deps.mgr.runtimeSettings.get());
  const before = state.ok ? state.settings : {};
  const shown = Object.entries(input as Record<string, unknown>).map(([k, v]) => `${k}: ${JSON.stringify(before[k] ?? null)} → ${JSON.stringify(v)}`).join(', ');
  const actor = await act(ctx, deps, `Runtime ${rid} settings: ${shown || '(none)'}`, { settings: rid, value: input });
  if (actor instanceof Response) return actor;
  let r;
  try { r = await deps.mgr.runtimeSettings.setSettings(rid, input); } catch (err) { return errorResponse(err); }
  if (!r.ok) return conflict();
  if (r.changed) {
    await deps.audit(actor, A.settingsChanged, { target: `runtime:${rid}`, detail: { from: r.previous.settings[rid] ?? null, to: r.record.settings[rid] } });
  }
  const settings = deps.mgr.runtimes.settingsOf(rid, r.record);
  // ARI module hook: new settings apply to new starts; a module says whether running instances are affected.
  const applied = r.changed ? await deps.mgr.runtimes.require(rid).applySettings?.(settings, before) : undefined;
  return json({ ok: true, changed: r.changed, settings, ...(applied ? { affectsRunning: applied.affectsRunning } : {}) });
}

/** POST :id/enable | :id/disable. */
export async function postEnabled(ctx: Ctx, id: string | undefined, on: boolean, deps: RuntimesDeps = liveRuntimesDeps()): Promise<Response> {
  const rid = known(deps, id);
  if (rid instanceof Response) return rid;
  let stopInstances = false;
  if (!on) {
    // A runtime that can never be disabled says so first, not "stop its instances".
    const refusal = deps.mgr.runtimeSettings.disableRefusal(rid, await deps.mgr.runtimeSettings.get());
    if (refusal) return errorResponse(refusal);
    const body = await readBody(ctx);
    stopInstances = !(body instanceof Response) && body['stopInstances'] === true;
  }
  const running = on ? [] : deps.mgr.getAllInstances()
    .filter((i) => i.sandbox === rid && i.state !== 'destroyed' && i.state !== 'error').map((i) => i.instanceId);
  if (running.length && !stopInstances) {
    return json({
      error: 'instances-running', instances: running,
      message: `${running.length} instance(s) run on ${rid}: disable with stopInstances to stop them, or stop them first.`,
    }, 409);
  }
  const actor = await act(ctx, deps, `${on ? 'Enable' : 'Disable'} the ${rid} runtime${running.length ? ` and stop ${running.length} instance(s)` : ''}`,
    { [on ? 'enable' : 'disable']: rid, stop: running },
    on ? [] : ['Apps on it stay installed; starting one fails with "runtime disabled". Nothing is moved to another runtime.']);
  if (actor instanceof Response) return actor;
  let r;
  try { r = await deps.mgr.runtimeSettings.setEnabled(rid, on); } catch (err) { return errorResponse(err); }
  if (!r.ok) return conflict();
  if (r.changed) await deps.audit(actor, on ? A.enabled : A.disabled, { target: `runtime:${rid}`, ...(running.length ? { detail: { stopped: running } } : {}) });
  const stopped: string[] = [];
  for (const inst of running) {
    try { await deps.mgr.stop(inst); stopped.push(inst); } catch (err) { console.warn(`[runtimes] stop ${inst} failed: ${(err as Error).message}`); }
  }
  // ARI module hooks (no-ops for the built-ins); `disable` only once no instance runs on it.
  if (r.changed) {
    const module = deps.mgr.runtimes.require(rid);
    try {
      if (on) await module.enable?.(deps.mgr.runtimes.settingsOf(rid, r.record));
      else if (stopped.length === running.length) await module.disable?.();
    } catch (err) { console.warn(`[runtimes] ${rid} ${on ? 'enable' : 'disable'} hook failed: ${(err as Error).message}`); }
  }
  return json({ ok: true, changed: r.changed, enabled: r.record.enabled, ...(stopped.length ? { stopped } : {}) });
}

/** DELETE overrides/:installationId. */
export async function deleteOverride(ctx: Ctx, installationId: string | undefined, deps: RuntimesDeps = liveRuntimesDeps()): Promise<Response> {
  if (!installationId || !/^[A-Za-z0-9-]{1,64}$/.test(installationId)) return json({ error: 'invalid-request', message: 'an installation id is required' }, 400);
  const record = await deps.mgr.runtimeSettings.get();
  const o = record.overrides[installationId];
  if (!o) return json({ error: 'not-found', message: 'no runtime override for this installation' }, 404);
  const actor = await act(ctx, deps, `Remove the ${o.source} runtime override of ${o.appId ?? installationId} (${o.runtime})`,
    { removeOverride: installationId },
    ['The app then follows its manifest or the default, checked against that runtime at its next start.']);
  if (actor instanceof Response) return actor;
  let r;
  try { r = await deps.mgr.runtimeSettings.removeOverride(installationId); } catch (err) { return errorResponse(err); }
  if (!r.ok) return conflict();
  await deps.audit(actor, A.overrideRemoved, { target: `installation:${installationId}`, detail: { appId: o.appId, runtime: o.runtime, source: o.source } });
  return json({ ok: true, removed: { installationId, ...r.result } });
}

/** POST migrate `{appId, decision: 'adopt-default' | 'keep', runtime?}` (D75 step 5). */
export async function postMigrate(ctx: Ctx, deps: RuntimesDeps = liveRuntimesDeps()): Promise<Response> {
  const body = await readBody(ctx);
  if (body instanceof Response) return body;
  const { appId, decision, runtime } = body as { appId?: unknown; decision?: unknown; runtime?: unknown };
  if (typeof appId !== 'string' || (decision !== 'adopt-default' && decision !== 'keep')) {
    return json({ error: 'invalid-request', message: 'expected { appId, decision: "adopt-default" | "keep", runtime? }' }, 400);
  }
  if (decision === 'keep' && (typeof runtime !== 'string' || !core.RUNTIME_ID_PATTERN.test(runtime))) {
    return json({ error: 'invalid-request', message: 'keep needs a runtime (e.g. proot)' }, 400);
  }
  const app = (await deps.mgr.runtimeApps()).find((a) => a.appId === appId);
  if (!app) return json({ error: 'not-found', message: `unknown app: ${appId}` }, 404);
  if (!app.installationId) return json({ error: 'not-ready', message: `${appId} has no recorded installation yet` }, 409);
  const record = await deps.mgr.runtimeSettings.get();
  if (!record.pending?.[app.installationId]) return json({ error: 'not-found', message: `${appId} has no runtime migration decision open` }, 404);
  const target = decision === 'keep' ? runtime as string : record.default;
  const actor = await act(ctx, deps, decision === 'keep' ? `Keep ${appId} on ${target}` : `Move ${appId} to the default runtime (${target})`,
    { migrate: app.installationId, decision, runtime: target },
    ['Non-destructive: the installation, its data, permissions and configuration stay; only its runtime changes.']);
  if (actor instanceof Response) return actor;
  let r;
  try {
    r = await core.decideMigration(deps.mgr.runtimeSettings, deps.mgr.runtimes, { ...app, installationId: app.installationId },
      decision === 'keep' ? { keep: target } : { adoptDefault: true });
  } catch (err) { return errorResponse(err); }
  if (!r.ok) return conflict();
  await deps.audit(actor, A.migrationDecided, {
    target: `installation:${app.installationId}`, detail: { appId, decision, runtime: r.result.runtime, legacy: r.result.pending.legacy },
  });
  return json({ ok: true, appId, runtime: r.result.runtime });
}

/**
 * POST check `{runtime, appId?, needs?: string[], requirements?}`: would this
 * run there? Read-only (ARI §5.1): the capabilities `needs` names (capability
 * names or request kinds: `jump`, `home-private|app|ephemeral`, `mount`,
 * `idmap-mount`, `closed`, `sidecars`, `port-expose`, `host-filesystem`), plus
 * an app's `requirements` (core `requirementsOf`, D85 A5: what `aura dev
 * validate` sends), plus, with `appId`, what that installed app needs. One
 * derivation (core runtimes/requirements.ts). Answers `capability-missing`
 * with the list and `suggest`: the enabled runtimes that could run it (D73).
 */
export async function postCheck(ctx: Ctx, deps: RuntimesDeps = liveRuntimesDeps()): Promise<Response> {
  const body = await readBody(ctx);
  if (body instanceof Response) return body;
  const rid = known(deps, body['runtime']);
  if (rid instanceof Response) return rid;
  const needs: Partial<RuntimeCapabilities> = {};
  const names = Array.isArray(body['needs']) ? body['needs'] : [];
  for (const n of names) {
    if (typeof n !== 'string') return json({ error: 'invalid-request', message: 'needs are strings' }, 400);
    if (core.isRequestKind(n)) Object.assign(needs, core.requestNeeds(n));
    else if (core.RUNTIME_BOOLEAN_CAPABILITIES.includes(n as keyof RuntimeCapabilities)) (needs as Record<string, boolean>)[n] = true;
    else return json({ error: 'invalid-request', message: `unknown need: ${n}` }, 400);
  }
  const req = body['requirements'];
  if (req !== undefined) {
    const given = req && typeof req === 'object' && !Array.isArray(req) ? (req as { needs?: unknown }).needs : undefined;
    if (!given || typeof given !== 'object' || Array.isArray(given)) return json({ error: 'invalid-request', message: 'requirements.needs is an object' }, 400);
    for (const [k, v] of Object.entries(given as Record<string, unknown>)) {
      if (!(core.RUNTIME_CAPABILITY_KEYS as readonly string[]).includes(k)) return json({ error: 'invalid-request', message: `unknown capability: ${k}` }, 400);
      (needs as Record<string, unknown>)[k] = v;
    }
  }
  if (typeof body['appId'] === 'string') {
    const app = (await deps.mgr.runtimeApps()).find((a) => a.appId === body['appId']);
    if (!app) return json({ error: 'not-found', message: `unknown app: ${String(body['appId'])}` }, 404);
    Object.assign(needs, core.requirementsOf(app.manifest, { sourceMode: app.sourceMode }).needs);
  }
  const record = await deps.mgr.runtimeSettings.get();
  const module = deps.mgr.runtimes.require(rid);
  const state = deps.mgr.runtimes.settingsState(rid, record);
  const settings = state.ok ? state.settings : core.settingsDefaults(module.descriptor.settingsSchema);
  const capabilities = module.capabilities(settings);
  const missing = core.missingCapabilities(capabilities, needs);
  const unavailable = core.healthRefusal(deps.mgr.runtimes.healthOf(rid, record));
  const enabled = deps.mgr.runtimes.isEnabled(rid, record);
  const suggest = missing.length ? deps.mgr.runtimes.suggest(needs, record, rid) : [];
  return json({
    runtime: rid, ok: missing.length === 0 && enabled && !unavailable, enabled, needs, capabilities, missing,
    ...(missing.length ? { code: 'capability-missing', suggest } : {}),
    ...(unavailable ? { unavailable } : {}),
  });
}
