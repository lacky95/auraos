/**
 * `/api/admin/system-patches` (Phase 7b, D68): the server side of `aura
 * system patch`. The kernel's engine (`core.systemPatches`) owns the store
 * and the workspaces and drives the release builder; this file authorizes,
 * binds the workspace into the caller's Terminal, asks the owner, audits.
 *
 *   GET                       status: mode, the running release and its provenance, the store
 *                             (head, active, approved, log), the head series, needs-repair, last jobs
 *   GET ?diff=<rev>           the exact diff of a revision
 *   GET ?job=<id>             a builder job (its checklist)
 *   POST { action }           (Developer Mode: 409 with the workflow, D68 owner answer 3)
 *     start  { base?, new? }  a workspace (mirror at the release + the active series), bound writable
 *                             into the CALLING Terminal at /mnt/aura/work/system (drafting: no approval, D68)
 *     save   { message? }     the bound workspace → a validated store revision; audit patch.saved
 *     disable|enable { patch }  a new revision with the flag changed: disable one click, enable `fresh`
 *     validate { rev? }       the unapproved series built and checked in throwaway containers
 *                             (builder --validate-only), a background job
 *     activate { job }        the owner approves the EXACT validated revision at `fresh`
 *                             (`system.patch.activate`: release, PatchBinding, components, D35);
 *                             then the approved build, then the activation (Phase 6 U)
 *
 * Who: the owner (a login, the owner's System Terminal, the host operator).
 * Members are refused (`ownerAction`, and the owner check below for drafting).
 */
import * as core from '@aura/core';
import type { APIContext } from 'astro';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CallerPrincipal } from './access/identify.ts';
import { auditOwner, ownerAction, type OwnerActionDeps, type OwnerActor } from './approvals/admin.ts';
import { json } from './approvals/service.ts';

type SP = typeof core.systemPatches;
type RouteCtx = Pick<APIContext, 'request' | 'cookies'> & { clientAddress?: string };

export const DEVELOPER_MODE_ANSWER = 'Developer Mode: change AuraOS in /workspace and commit (the owner manages git). '
  + 'System patches apply to Normal-mode installs that run from a release (D68).';

/** Paths of the Phase 6 release layout (os/release/layout.mjs; verify after 6: Stage 1b paths.ts is the one list). */
const POINTER = 'aura/release/pointer.json';
const SOURCE = 'aura/release/source.json';
const MIRROR = 'aura/release/mirror.git';
const JOBS = 'aura/release/jobs';
const JOB_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const RELEASE_ID_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,100}$/;

export interface ReleaseInfo {
  id: string; version: string | null; commit: string; channel: 'signed' | 'main'; composition: string;
  provenance: string; series?: { digest?: string; rev?: string | null; order?: unknown[] };
  meta?: { signed?: boolean; securityUpdate?: boolean };
  basedOn?: { version: string | null; signed: boolean };
}

/**
 * Release activation (Phase 6 stream U: snapshot, pointer switch, writes held,
 * health, automatic rollback). Verify after 6: U provides it; until then the
 * approved release is built and left ready, and nothing switches.
 */
export interface ReleaseActivator {
  activate(input: { releaseId: string; jobId: string; endsSessions: string[]; when: 'now' | 'next-start' }): Promise<{ ok: boolean; rolledBack?: boolean; reason?: string }>;
}

export interface SystemPatchDeps {
  dataDir: string;
  auraRoot: string;
  mode(): 'developer' | 'normal';
  authenticate(request: Request): Promise<CallerPrincipal | Response>;
  owner: OwnerActionDeps;
  engine: SP;
  /** The data volume's name (the builder's volume-subpath mounts). */
  dataVolume(): string;
  mounts: {
    list(instanceId: string): core.AuraMount[];
    add(instanceId: string, spec: core.AddMountSpec): Promise<core.AuraMount>;
    remove(instanceId: string, mountId: string): Promise<void>;
  };
  /** Starts the builder; resolves when it ends (the job file is the record). */
  runBuilder(input: core.systemPatches.BuilderInput): Promise<core.systemPatches.BuilderRun>;
  activator: ReleaseActivator | null;
  audit(actor: OwnerActor | null, action: string, opts: { target?: string; outcome?: 'ok' | 'denied' | 'failed'; detail?: Record<string, unknown> }): Promise<void>;
  notify(title: string, body: string): Promise<void>;
}

const readJson = <T>(f: string): T | null => { try { return JSON.parse(readFileSync(f, 'utf8')) as T; } catch { return null; } };

export function currentRelease(dataDir: string): ReleaseInfo | null {
  const p = readJson<{ current?: string }>(join(dataDir, POINTER));
  if (!p?.current || !RELEASE_ID_RE.test(p.current)) return null;
  const dir = join(dataDir, 'releases', p.current);
  if (!existsSync(join(dir, '.complete'))) return null;
  return readJson<ReleaseInfo>(join(dir, 'release.json'));
}

function readJob(dataDir: string, id: string): Record<string, unknown> | null {
  if (!JOB_ID_RE.test(id)) return null;
  return readJson(join(dataDir, JOBS, `${id}.json`));
}

const newJobId = (): string => new Date().toISOString().replace(/[:.]/g, '-');

/** Whether system patches can run here (a Normal-mode install running from a release). */
export function availability(deps: SystemPatchDeps): { ok: true; release: ReleaseInfo } | { ok: false; status: number; error: string; message: string } {
  if (deps.mode() === 'developer') return { ok: false, status: 409, error: 'developer-mode', message: DEVELOPER_MODE_ANSWER };
  const release = currentRelease(deps.dataDir);
  if (!release) {
    return { ok: false, status: 409, error: 'no-release', message: 'This install does not run from a release (the Phase 6 Normal layout): system patches need one (D68).' };
  }
  return { ok: true, release };
}

/** The owner, for drafting (no approval, D68): a login of the owner, the owner's Terminal, the host operator. */
function ownerOf(p: CallerPrincipal): { userId: string; instanceId?: string } | null {
  if (p.kind === 'operator') return { userId: core.DEFAULT_OWNER_ID };
  if (core.isForeignPrincipal(p as { systemId?: unknown })) return null;
  if (p.kind === 'user') return p.role === 'owner' ? { userId: p.userId } : null;
  if (p.kind === 'instance') {
    if (p.sidecar) return null;
    const userId = p.userId ?? core.DEFAULT_OWNER_ID;
    return userId === core.DEFAULT_OWNER_ID ? { userId, instanceId: p.instanceId } : null;
  }
  return null;
}

function engineError(err: unknown): Response {
  const e = err as { code?: string; message?: string };
  const status = e.code === 'no-series' || e.code === 'no-patch' ? 404 : e.code === 'refused' || e.code === 'bad-rev' ? 422 : 409;
  return json({ error: e.code ?? 'failed', message: e.message ?? String(err) }, status);
}

const workRoot = (deps: SystemPatchDeps, userId: string): string =>
  join(deps.dataDir, dirname(core.workspaceSubpath(userId, deps.engine.SYSTEM_INSTALLATION, 1)));

// ── GET ─────────────────────────────────────────────────────────────────────

export async function getSystemPatches(ctx: RouteCtx, deps: SystemPatchDeps): Promise<Response> {
  const url = new URL(ctx.request.url);
  const E = deps.engine;
  const diffRev = url.searchParams.get('diff');
  const job = url.searchParams.get('job');
  try {
    if (diffRev !== null) {
      const rev = E.resolveRev(deps.dataDir, diffRev || 'HEAD');
      return json({ rev, diff: E.seriesDiff(deps.dataDir, rev), series: E.seriesView(deps.dataDir, rev) });
    }
    if (job !== null) {
      const j = readJob(deps.dataDir, job);
      return j ? json(j) : json({ error: 'not-found' }, 404);
    }
  } catch (err) { return engineError(err); }
  const avail = availability(deps);
  const head = E.storeRef(deps.dataDir, 'HEAD');
  const release = avail.ok ? avail.release : null;
  return json({
    mode: deps.mode(),
    available: avail.ok,
    ...(avail.ok ? {} : { reason: avail.message }),
    release: release ? {
      id: release.id, version: release.version, commit: release.commit, channel: release.channel, composition: release.composition,
      provenance: release.provenance, series: release.series?.digest ?? null, patches: release.series?.order?.length ?? 0,
      // D71: the running release is never called signed when it is locally modified.
      line: provenanceLine(release),
    } : null,
    store: {
      head, active: E.storeRef(deps.dataDir, E.ACTIVE_REF), approved: E.approvedRevs(deps.dataDir), log: E.seriesLog(deps.dataDir, 10),
    },
    series: head ? safe(() => E.seriesView(deps.dataDir, head)) : null,
    needsRepair: E.readNeedsRepair(deps.dataDir),
  });
}

const safe = <T>(f: () => T): T | null => { try { return f(); } catch { return null; } };

/** "AuraOS <v>, locally modified (N system patches, series <d7>), based on signed <v>" (D71). */
export function provenanceLine(r: ReleaseInfo): string {
  const v = r.version ?? 'main';
  if (r.provenance !== 'locally-modified') return `AuraOS ${v} (${r.provenance === 'upstream-signed' ? 'signed release' : 'unsigned revision'})`;
  const n = r.series?.order?.length ?? 0;
  const d = (r.series?.digest ?? '').replace(/^sha256:/, '').slice(0, 7);
  const base = r.basedOn?.signed ? `signed ${r.basedOn.version ?? v}` : 'an unsigned revision';
  return `AuraOS ${v}, locally modified (${n} system patch${n === 1 ? '' : 'es'}${d ? `, series ${d}` : ''}), based on ${base}`;
}

// ── POST ────────────────────────────────────────────────────────────────────

interface Body { action?: unknown; base?: unknown; new?: unknown; message?: unknown; patch?: unknown; rev?: unknown; job?: unknown; when?: unknown }

export async function postSystemPatches(ctx: RouteCtx, deps: SystemPatchDeps): Promise<Response> {
  let body: Body;
  try { body = await ctx.request.json() as Body; } catch { return json({ error: 'invalid-json' }, 400); }
  const avail = availability(deps);
  if (!avail.ok) return json({ error: avail.error, message: avail.message }, avail.status);
  const release = avail.release;
  const E = deps.engine;
  try {
    switch (body.action) {
      case 'start': return await start(ctx, deps, release, body);
      case 'save': return await save(ctx, deps, body);
      case 'disable':
      case 'enable': return await toggle(ctx, deps, body.action, body);
      case 'validate': {
        const who = await drafter(ctx, deps);
        if (who instanceof Response) return who;
        const rev = E.resolveRev(deps.dataDir, typeof body.rev === 'string' ? body.rev : 'HEAD');
        const jobId = newJobId();
        void deps.runBuilder(builderInput(deps, release, rev, jobId, { validateOnly: true }));
        return json({ ok: true, job: jobId, rev }, 202);
      }
      case 'activate': return await activate(ctx, deps, release, body);
      default: return json({ error: 'invalid-action', message: 'action: start | save | disable | enable | validate | activate' }, 400);
    }
  } catch (err) {
    return engineError(err);
  }
}

function builderInput(deps: SystemPatchDeps, release: ReleaseInfo, rev: string, jobId: string, o: { validateOnly?: boolean; imageChangeApproved?: boolean; expectSeriesDigest?: string }): core.systemPatches.BuilderInput {
  return {
    auraRoot: deps.auraRoot, dataDir: deps.dataDir, dataVolume: deps.dataVolume(),
    // The base commit is in the mirror already: the builder re-verifies it there (D71), no network.
    fetchFrom: join(deps.dataDir, MIRROR),
    channel: release.channel, ref: release.channel === 'signed' && release.version ? `v${release.version}` : release.commit,
    commit: release.commit, composition: release.composition, rev, jobId, ...o,
  };
}

async function drafter(ctx: RouteCtx, deps: SystemPatchDeps): Promise<{ userId: string; instanceId?: string } | Response> {
  const p = await deps.authenticate(ctx.request);
  if (p instanceof Response) return p;
  const who = ownerOf(p);
  return who ?? json({ error: 'owner-required' }, 403);
}

async function start(ctx: RouteCtx, deps: SystemPatchDeps, release: ReleaseInfo, body: Body): Promise<Response> {
  const who = await drafter(ctx, deps);
  if (who instanceof Response) return who;
  if (!who.instanceId) return json({ error: 'terminal-only', message: 'a system patch workspace is bound into a System Terminal: run `aura system patch start` there' }, 409);
  let base = { commit: release.commit, release: release.id as string | null, version: release.version };
  if (body.base !== undefined) {
    if (typeof body.base !== 'string' || !RELEASE_ID_RE.test(body.base)) return json({ error: 'invalid-base' }, 400);
    const other = readJson<ReleaseInfo>(join(deps.dataDir, 'releases', body.base, 'release.json'));
    if (!other || !existsSync(join(deps.dataDir, 'releases', body.base, '.complete'))) {
      return json({ error: 'unknown-release', message: `no release ${body.base} on this install` }, 404);
    }
    base = { commit: other.commit, release: other.id, version: other.version };
  }
  const r = deps.engine.startWorkspace({
    dataDir: deps.dataDir, userId: who.userId, root: workRoot(deps, who.userId), mirror: join(deps.dataDir, MIRROR), base, fresh: body.new === true,
  });
  const subpath = core.workspaceSubpath(who.userId, deps.engine.SYSTEM_INSTALLATION, r.n);
  const id = `${core.SYSTEM_WORK_TARGET}:work`;
  const bound = deps.mounts.list(who.instanceId).find((m) => m.id === id);
  let mount = bound?.workspace === subpath ? bound : undefined;
  try {
    if (bound && !mount) await deps.mounts.remove(who.instanceId, bound.id);
    mount ??= await deps.mounts.add(who.instanceId, { targetAppId: core.SYSTEM_WORK_TARGET, workspace: subpath });
  } catch (err) {
    return json({ error: 'mount-failed', message: (err as Error).message }, 409);
  }
  return json({ ok: true, path: mount.containerPath, n: r.n, created: r.created, base, apply: r.apply });
}

async function save(ctx: RouteCtx, deps: SystemPatchDeps, body: Body): Promise<Response> {
  const who = await drafter(ctx, deps);
  if (who instanceof Response) return who;
  if (!who.instanceId) return json({ error: 'terminal-only', message: 'save from the System Terminal the workspace is bound into' }, 409);
  const bound = deps.mounts.list(who.instanceId).find((m) => m.id === `${core.SYSTEM_WORK_TARGET}:work`);
  if (!bound?.workspace) return json({ error: 'no-workspace', message: 'no system patch workspace is bound here: aura system patch start' }, 409);
  const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim().slice(0, 500) : 'save';
  const r = deps.engine.saveWorkspace({ dataDir: deps.dataDir, workspace: join(deps.dataDir, bound.workspace), message: `${message}\n\nSaved by ${who.userId} (${who.instanceId})` });
  if (r.changed) {
    await deps.audit(null, core.PATCH_AUDIT_ACTIONS.saved, { target: 'system', detail: { rev: r.rev, digest: r.digest, patches: r.patches, by: who.userId, instance: who.instanceId } });
  }
  return json({ ok: true, ...r });
}

async function toggle(ctx: RouteCtx, deps: SystemPatchDeps, action: 'disable' | 'enable', body: Body): Promise<Response> {
  if (typeof body.patch !== 'string' || !body.patch) return json({ error: 'invalid-patch' }, 400);
  const view = deps.engine.seriesView(deps.dataDir, 'HEAD');
  const actor = await ownerAction(ctx, {
    action: 'admin.change',
    payload: { change: `system-patch.${action}`, rev: view.rev, patch: body.patch },
    // Disabling moves toward upstream (one click); enabling re-introduces local code (the password).
    level: action === 'enable' ? 'fresh' : 'session',
    title: `${action === 'enable' ? 'Enable' : 'Disable'} system patch ${body.patch}`,
    details: [`Series revision ${view.rev.slice(0, 12)}`, 'A new revision is saved; nothing runs until it is activated.'],
  }, deps.owner);
  if (actor instanceof Response) return actor;
  const r = deps.engine.setPatchEnabled({ dataDir: deps.dataDir, patch: body.patch, enabled: action === 'enable', message: `${action} ${body.patch}` });
  await deps.audit(actor, action === 'enable' ? core.PATCH_AUDIT_ACTIONS.enabled : core.PATCH_AUDIT_ACTIONS.disabled, { target: 'system', detail: { rev: r.rev, digest: r.digest, file: r.file } });
  return json({ ok: true, ...r });
}

async function activate(ctx: RouteCtx, deps: SystemPatchDeps, release: ReleaseInfo, body: Body): Promise<Response> {
  const E = deps.engine;
  if (typeof body.job !== 'string') return json({ error: 'invalid-job', message: 'activate { job }: the id of a finished validation (action validate)' }, 400);
  const job = readJob(deps.dataDir, body.job) as { phase?: string; validated?: Parameters<SP['systemPatchBinding']>[0]['validated'] } | null;
  if (!job) return json({ error: 'not-found' }, 404);
  if (job.phase !== 'validated' || !job.validated) return json({ error: 'not-validated', message: `job ${body.job} is ${job.phase ?? 'unknown'}, not a finished validation` }, 409);
  const v = job.validated;
  if (v.commit !== release.commit || v.composition !== release.composition) {
    return json({ error: 'stale-validation', message: 'the running release changed since this validation: validate again' }, 409);
  }
  const rev = v.series.rev;
  if (!rev) return json({ error: 'not-validated' }, 409);
  // The binding is recomputed from the STORE at that revision and compared with the validated build.
  const binding = E.systemPatchBinding({ dataDir: deps.dataDir, rev, validated: v });
  const view = E.seriesView(deps.dataDir, rev);
  const sessions = E.endsSessions(binding);
  const when = body.when === 'now' ? 'now' : 'next-start';
  const highRisk = [
    ...(binding.rebuildsImage ? [{ item: 'Rebuilds the AuraOS images', why: 'the series changes the Dockerfile or the files the images copy; the image build runs after this approval', added: true }] : []),
    ...(sessions.length ? [{ item: `Active Terminal sessions end when this activates (${sessions.join(', ')})`, why: when === 'now' ? 'you chose to activate now' : 'it activates on the next start unless you choose now (D35)', added: true }] : []),
    { item: 'Locally modified AuraOS', why: 'the running release will no longer be the maintainer-signed one (D71)', added: true },
  ];
  const actor = await ownerAction(ctx, {
    action: 'system.patch.activate',
    payload: { ...binding, when },
    level: 'fresh',
    title: `Activate ${view.patches.filter((p) => p.enabled).length} system patch(es) on AuraOS ${binding.version ?? 'main'}`,
    details: E.approvalDetails(binding, view),
    highRisk,
    diff: E.seriesDiff(deps.dataDir, rev),
    // A desktop session alone never activates: the dialog with the password, or the host operator (D68).
    confirmed: { where: 'Activate from the System Terminal (aura system patch activate) and approve in the dialog with your password, or on the host.' },
  }, deps.owner);
  if (actor instanceof Response) return actor;
  const n = E.markApproved(deps.dataDir, rev);
  const jobId = newJobId();
  void (async () => {
    const run = await deps.runBuilder(builderInput(deps, release, rev, jobId, { imageChangeApproved: binding.rebuildsImage, expectSeriesDigest: v.series.digest }));
    if (run.code !== 0) {
      await deps.audit(actor, core.PATCH_AUDIT_ACTIONS.activationFailed, { target: 'system', outcome: 'failed', detail: { rev, step: (run.result?.['step'] as string) ?? 'build', reason: String(run.result?.['error'] ?? run.code).slice(0, 300) } });
      return;
    }
    const releaseId = String(run.result?.['id'] ?? binding.releaseId);
    if (!deps.activator) {
      // verify after 6: Phase 6 U activates (snapshot, switch, writes held, health, automatic rollback).
      await deps.audit(actor, core.PATCH_AUDIT_ACTIONS.activationFailed, { target: 'system', outcome: 'failed', detail: { rev, releaseId, step: 'activate', reason: 'release activation arrives with Phase 6 U: the release is built and ready' } });
      return;
    }
    const a = await deps.activator.activate({ releaseId, jobId, endsSessions: sessions, when });
    if (a.ok) {
      E.markActive(deps.dataDir, rev);
      await deps.audit(actor, core.PATCH_AUDIT_ACTIONS.activated, { target: 'system', detail: { rev, digest: binding.series.seriesDigest, baseCommit: binding.commit, releaseId, approved: n } });
    } else {
      await deps.audit(actor, a.rolledBack ? core.PATCH_AUDIT_ACTIONS.rolledBack : core.PATCH_AUDIT_ACTIONS.activationFailed, { target: 'system', outcome: 'failed', detail: { rev, releaseId, reason: a.reason ?? 'failed', automatic: true } });
      await deps.notify('System patch activation rolled back', `${releaseId}: ${a.reason ?? 'the new release did not become healthy'}. The previous release runs.`);
    }
  })();
  return json({ ok: true, job: jobId, rev, approved: n, release: binding.releaseId, when }, 202);
}

/** The live dependencies. */
export function liveSystemPatchDeps(base: { authenticate: SystemPatchDeps['authenticate']; owner: OwnerActionDeps; mode: SystemPatchDeps['mode'] }): SystemPatchDeps {
  const dataDir = process.env['AURA_DATA_DIR'] ?? '/data';
  return {
    dataDir,
    auraRoot: process.env['AURA_WORKSPACE_DIR'] ?? '/workspace',
    mode: base.mode,
    authenticate: base.authenticate,
    owner: base.owner,
    engine: core.systemPatches,
    dataVolume: () => core.getAppManager().dataVolumeName(),
    mounts: {
      list: (i) => core.getAppManager().mounts.list(i),
      add: (i, s) => core.getAppManager().mounts.add(i, s),
      remove: (i, m) => core.getAppManager().mounts.remove(i, m),
    },
    runBuilder: (i) => core.systemPatches.runBuilder(i, { log: (l) => console.log(`[system-patch] ${l}`) }),
    activator: null,
    audit: (actor, action, opts) => auditOwner(actor, action, opts),
    notify: async (title, body) => { console.warn(`[system-patch] ${title}: ${body}`); },
  };
}
