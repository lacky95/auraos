/**
 * `/api/admin/release/**` (Phase 6 stream U): the owner's side of locked
 * releases on a Normal-mode install. The file work is the running release's
 * own os/release/activate.mjs (the trusted side, also run by the detached
 * updater); the switch itself is core SelfUpdater modes `release` and
 * `rollback`, after the planned-restart drain (lib/plannedRestart.ts).
 *
 *   GET    /api/admin/release                 current / previous release, channel, provenance, the
 *                                             held state (abandoned or verifying), snapshots, last jobs
 *   POST   /api/admin/release/build           build a release from the update channel (one click)
 *   POST   /api/admin/release/activate        { releaseId, when? } preflight, the approval
 *                                             `system.release.activate` on the release binding (forced),
 *                                             then drain → updater `release`
 *   POST   /api/admin/release/rollback        { restoreData?, confirmInsecure? } `fresh`; the data
 *                                             restore is its own explicit choice (Q35); never past a
 *                                             resolved critical fix (5b answer 1, D95 §14)
 *   POST   /api/admin/release/accept-writes   the updater's operator ticket (or the owner, `fresh`, when
 *                                             an activation was abandoned before it accepted writes)
 *   GET    /api/admin/release/jobs/<id>       a build or activation job checklist
 *
 * Developer Mode (live): 409 `developer-mode` with the workflow: the
 * Developer update is `aura update` (fast-forward only, SelfUpdater `update`).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as core from '@aura/core';
import type { APIContext } from 'astro';
import type { CallerPrincipal } from '../access/identify.ts';
import { auditOwner, ownerAction, type AdminRequest, type OwnerActor } from '../approvals/admin.ts';
import { json } from '../approvals/service.ts';
import { isDeveloperMode } from '../systemMode.ts';
import { TERMINAL_APP_ID } from '../../../server/session-hosts.mjs';

type RouteCtx = Pick<APIContext, 'request' | 'cookies'> & { clientAddress?: string };

/** The audit actions of a release (AdminAudit `release.*`). */
export const RELEASE_AUDIT = {
  build: 'release.build',
  activate: 'release.activate',
  activated: 'release.activated',
  rolledBack: 'release.rolled-back',
  rollback: 'release.rollback',
  rollbackInsecure: 'release.rollback-insecure',
  activationFailed: 'release.activation-failed',
  acceptedByOwner: 'release.accepted-by-owner',
} as const;

export const DEVELOPER_MODE_RELEASE = 'Developer Mode runs /workspace, not a release: update with `aura update` '
  + '(Settings → About), which fast-forwards the checkout and rebuilds (the owner manages git).';

/** The parts of os/release/activate.mjs the shell uses (one implementation, D36). */
export interface ActivationModule {
  status(dataRoot: string): ReleaseStatusView;
  preflight(dataRoot: string, o: { id: string; trustedTree: string; channel: string }): {
    blockers: Array<{ code: string; message: string }>;
    warnings: Array<{ code: string; message: string }>;
    record: ReleaseRecordView | null;
    meta: { advisories?: string[]; severity?: string; securityUpdate?: boolean; notes?: string } | null;
    binding: core.ReleaseActivationBinding | null;
  };
  sameBinding(a: unknown, b: unknown): boolean;
  rollbackTarget(dataRoot: string): { from: string; to: string };
  rollbackSecurity(dataRoot: string, o: { from: string; to: string; confirmInsecure?: string }): {
    allowed: boolean; needsConfirmation: boolean; critical: boolean; advisories: string[]; reason: string | null;
  };
  readRelease(dataRoot: string, id: string): ReleaseRecordView | null;
  releaseHold(dataRoot: string): boolean;
  readWritesHeld(dataRoot: string): core.WritesHeldMarker | null;
  changedApps(from: ReleaseRecordView | null, to: ReleaseRecordView | null): string[];
}

export interface ReleaseRecordView {
  id: string; version: string | null; commit: string; channel: 'signed' | 'main'; provenance: string;
  composition: 'desktop' | 'server'; auraContract: number | null; images?: { shell?: string };
  meta?: { signed?: boolean; securityUpdate?: boolean; severity?: string };
  components?: { source?: Array<{ name: string; kind: string; tree?: string }> };
}

export interface ReleaseStatusView {
  pointer: { current: string; previous: string | null; switchedAt: string; jobId: string } | null;
  current: Record<string, unknown> | null;
  previous: Record<string, unknown> | null;
  releases: unknown[];
  writesHeld: core.WritesHeldMarker | null;
  snapshots: Array<{ id: string; fromRelease: string; toRelease: string; jobId: string; createdAt: string; files: number }>;
  lock: unknown;
}

type Updater = Pick<core.SelfUpdater, 'isRunning' | 'readJob' | 'startBuild'>;

export interface ReleaseAdminDeps {
  dataDir: string;
  developerMode(): boolean;
  /** The running release's os/release/activate.mjs (or the checkout's in Developer Mode). */
  activation(): Promise<ActivationModule>;
  /** The running release's tree: its keys and activation code are the trusted side. */
  trustedTree(): string | null;
  updater(): Updater;
  /** D64 `update-channel` and `security-update-policy`. */
  channel(): Promise<'signed' | 'main'>;
  securityPolicy(): Promise<'follow-signed' | 'hold'>;
  authenticate(request: Request): Promise<CallerPrincipal | Response>;
  ownerAction(ctx: RouteCtx, req: AdminRequest): Promise<OwnerActor | Response>;
  audit(actor: OwnerActor | null, action: string, opts: { target?: string; outcome?: 'ok' | 'denied' | 'failed'; detail?: Record<string, unknown> }): Promise<void>;
  /** The drain + the detached updater (lib/plannedRestart.ts). */
  plannedRestart(opts: { mode: 'release' | 'rollback'; releaseId?: string; when?: 'now' | 'next-start'; restoreData?: boolean; confirmInsecure?: string }): Promise<{ ok: true; job: unknown } | { ok: false; error: string }>;
  /** Installed apps whose `auraContract` major the target release does not support (listed, never blocking: G refuses them at start). */
  incompatibleApps(auraContract: number | null): string[];
  /** The kernel: writes accepted. */
  acceptWrites(): void;
  /** Step 11: changed system apps onto the new release (M's updateInstance; D35 for the Terminal). */
  switchSystemApps(appIds: string[], when: 'now' | 'next-start'): Promise<void>;
  notify(title: string, text: string): Promise<void>;
}

const readJson = <T>(f: string): T | null => { try { return JSON.parse(readFileSync(f, 'utf8')) as T; } catch { return null; } };

function developer(deps: ReleaseAdminDeps): Response | null {
  if (!deps.developerMode()) return null;
  return json({ error: 'developer-mode', message: DEVELOPER_MODE_RELEASE }, 409);
}

function trusted(deps: ReleaseAdminDeps): string | Response {
  const t = deps.trustedTree();
  return t ?? json({ error: 'no-release', message: 'This install does not run from a release (no pointer): releases need the Normal layout (install.sh).' }, 409);
}

/** A held state with no job behind it: the last activation died before it accepted writes. */
export function heldState(deps: Pick<ReleaseAdminDeps, 'updater'>, marker: core.WritesHeldMarker | null): { marker: core.WritesHeldMarker; abandoned: boolean } | null {
  if (!marker) return null;
  return { marker, abandoned: !deps.updater().isRunning() };
}

// ── GET ─────────────────────────────────────────────────────────────────────

export async function getStatus(deps: ReleaseAdminDeps): Promise<Response> {
  const updater = deps.updater();
  const lastJob = updater.readJob();
  if (deps.developerMode() && !deps.trustedTree()) {
    return json({ mode: 'developer', message: DEVELOPER_MODE_RELEASE, job: lastJob });
  }
  const act = await deps.activation();
  const st = act.status(deps.dataDir);
  const source = readJson<{ url?: string; channel?: string; maturity?: string }>(core.releasePaths.dataLayout().source);
  return json({
    mode: deps.developerMode() ? 'developer' : 'normal',
    channel: await deps.channel(),
    securityPolicy: await deps.securityPolicy(),
    source: source ? { url: source.url ?? null, channel: source.channel ?? null, maturity: source.maturity ?? null } : null,
    ...st,
    held: heldState(deps, st.writesHeld),
    running: updater.isRunning(),
    job: lastJob,
  });
}

export function getJob(deps: ReleaseAdminDeps, id: string): Response {
  if (!core.releasePaths.JOB_ID_RE.test(id)) return json({ error: 'invalid-job-id' }, 400);
  const build = readJson<Record<string, unknown>>(core.releasePaths.dataLayout().job(id));
  const job = build ?? deps.updater().readJob(id);
  return job ? json({ job }) : json({ error: 'not-found' }, 404);
}

// ── build ───────────────────────────────────────────────────────────────────

export async function postBuild(ctx: RouteCtx, deps: ReleaseAdminDeps, body: { ref?: unknown; maturity?: unknown }): Promise<Response> {
  const dev = developer(deps); if (dev) return dev;
  const t = trusted(deps); if (t instanceof Response) return t;
  if (body.ref !== undefined && typeof body.ref !== 'string') return json({ error: 'invalid-ref' }, 400);
  if (body.maturity !== undefined && !['alpha', 'beta', 'stable'].includes(body.maturity as string)) return json({ error: 'invalid-maturity' }, 400);
  const source = readJson<{ url?: string }>(core.releasePaths.dataLayout().source);
  if (!source?.url) return json({ error: 'no-source', message: 'No release source recorded (aura/release/source.json, written by install.sh).' }, 409);
  const act = await deps.activation();
  const cur = act.status(deps.dataDir).pointer?.current;
  const curRec = cur ? act.readRelease(deps.dataDir, cur) : null;
  const channel = await deps.channel();
  const ref = body.ref as string | undefined;
  const maturity = body.maturity as string | undefined;
  const actor = await deps.ownerAction(ctx, {
    action: 'admin.change', level: 'session',
    payload: { op: 'release.build', channel, ref: ref ?? null, maturity: maturity ?? null },
    title: `Build an AuraOS release${ref ? ` (${ref})` : ''} from the ${channel} channel`,
    details: [
      channel === 'signed' ? 'Only a signed release is built; the signature is checked before anything of it runs.' : 'The main channel is unsigned: the release is shown as unsigned.',
      'The running release keeps running; activating the built release is a separate step.',
    ],
  });
  if (actor instanceof Response) return actor;
  const r = deps.updater().startBuild({ fetchFrom: source.url, channel, ...(ref ? { ref } : {}), ...(maturity ? { maturity } : {}), composition: curRec?.composition ?? 'desktop' });
  await deps.audit(actor, RELEASE_AUDIT.build, { target: 'system', outcome: r.ok ? 'ok' : 'failed', detail: { channel, ref: ref ?? null, ...(r.ok ? { job: r.jobId } : { reason: r.reason }) } });
  return r.ok ? json({ ok: true, job: r.jobId }, 202) : json({ ok: false, error: 'build-refused', message: r.reason }, 409);
}

// ── activate ────────────────────────────────────────────────────────────────

export async function postActivate(ctx: RouteCtx, deps: ReleaseAdminDeps, body: { releaseId?: unknown; when?: unknown }): Promise<Response> {
  const dev = developer(deps); if (dev) return dev;
  const t = trusted(deps); if (t instanceof Response) return t;
  if (typeof body.releaseId !== 'string' || !core.releasePaths.RELEASE_ID_RE.test(body.releaseId)) return json({ error: 'invalid-release-id' }, 400);
  const releaseId = body.releaseId;
  const when = body.when === 'now' ? 'now' : 'next-start';
  const act = await deps.activation();
  const channel = await deps.channel();
  const pre = act.preflight(deps.dataDir, { id: releaseId, trustedTree: t, channel });
  if (pre.blockers.length || !pre.record || !pre.binding) {
    return json({ ok: false, error: pre.blockers[0]?.code ?? 'refused', message: pre.blockers.map((b) => b.message).join('; '), blockers: pre.blockers }, 409);
  }
  const rec = pre.record;
  const incompatible = deps.incompatibleApps(rec.auraContract);
  const security = rec.meta?.securityUpdate === true && rec.meta.signed === true;
  const policy = await deps.securityPolicy();
  const terminal = TERMINAL_APP_ID;
  const details = [
    `Release ${rec.version ?? 'main'} (${rec.commit.slice(0, 12)}), ${rec.provenance === 'upstream-signed' ? 'signed upstream release' : rec.provenance === 'upstream-unsigned' ? 'unsigned (main channel)' : 'locally modified, not a signed release'}`,
    ...(security ? [`Signed security update${pre.meta?.severity ? ` (${pre.meta.severity})` : ''}${pre.meta?.advisories?.length ? `: ${pre.meta.advisories.join(', ')}` : ''}${policy === 'hold' ? ' — your policy treats it like any other update' : ''}`] : []),
    'AuraOS restarts on the new release; changes are held until it is healthy, and a failure before that rolls back automatically, data included.',
    ...pre.warnings.map((w) => w.message),
  ];
  const actor = await deps.ownerAction(ctx, {
    action: 'system.release.activate' as AdminRequest['action'],
    payload: { ...pre.binding, when },
    // Phase 4 level for upstream releases (one click); anything locally modified needs the password (Phase 7 raises patches).
    level: rec.provenance === 'locally-modified' ? 'fresh' : 'session',
    title: `Activate AuraOS ${rec.version ?? rec.id}`,
    details,
    highRisk: [
      ...(when === 'now' ? [{ item: `Active Terminal sessions end (${terminal})`, why: 'you chose to switch them now (D35)', added: true }] : []),
      ...(incompatible.length ? [{ item: `Apps that will not start on this release: ${incompatible.join(', ')}`, why: 'their auraContract major is newer than the release supports', added: true }] : []),
      ...(rec.provenance !== 'upstream-signed' ? [{ item: 'Not a maintainer-signed release', why: rec.provenance === 'upstream-unsigned' ? 'the main channel is unsigned' : 'it contains local modifications', added: true }] : []),
    ],
  });
  if (actor instanceof Response) return actor;
  // Recomputed after the approval: the approved release is the one switched to (any difference refuses).
  const again = act.preflight(deps.dataDir, { id: releaseId, trustedTree: t, channel });
  if (again.blockers.length || !act.sameBinding(again.binding, pre.binding)) {
    await deps.audit(actor, RELEASE_AUDIT.activationFailed, { target: 'system', outcome: 'failed', detail: { releaseId, step: 'binding', reason: again.blockers[0]?.message ?? 'the release changed after the approval' } });
    return json({ ok: false, error: 'binding-moved', message: again.blockers[0]?.message ?? 'The release changed after the approval: approve it again.' }, 409);
  }
  const res = await deps.plannedRestart({ mode: 'release', releaseId, when });
  await deps.audit(actor, RELEASE_AUDIT.activate, { target: 'system', outcome: res.ok ? 'ok' : 'failed', detail: { releaseId, when, binding: pre.binding, securityUpdate: security, ...(res.ok ? {} : { reason: res.error }) } });
  return res.ok ? json({ ok: true, job: res.job, releaseId, when }, 202) : json({ ok: false, error: 'activation-refused', message: res.error }, 409);
}

// ── rollback ────────────────────────────────────────────────────────────────

export async function postRollback(ctx: RouteCtx, deps: ReleaseAdminDeps, body: { restoreData?: unknown; confirmInsecure?: unknown }): Promise<Response> {
  const dev = developer(deps); if (dev) return dev;
  const t = trusted(deps); if (t instanceof Response) return t;
  const act = await deps.activation();
  let target: { from: string; to: string };
  try { target = act.rollbackTarget(deps.dataDir); } catch (e) {
    return json({ ok: false, error: (e as { code?: string }).code ?? 'no-previous', message: (e as Error).message }, 409);
  }
  const confirmInsecure = typeof body.confirmInsecure === 'string' ? body.confirmInsecure : undefined;
  const sec = act.rollbackSecurity(deps.dataDir, { ...target, ...(confirmInsecure ? { confirmInsecure } : {}) });
  if (sec.critical) return json({ ok: false, error: 'rollback-past-critical-fix', message: sec.reason, advisories: sec.advisories }, 409);
  if (!sec.allowed) return json({ ok: false, error: 'rollback-insecure', message: sec.reason, advisories: sec.advisories, confirm: 'send confirmInsecure with the advisories, comma-separated' }, 409);
  const restoreData = body.restoreData === true;
  const pointer = act.status(deps.dataDir).pointer;
  const snapshot = restoreData ? core.latestSnapshotInto(deps.dataDir, target.from, pointer?.jobId) : null;
  if (restoreData && !snapshot) {
    return json({ ok: false, error: 'no-snapshot', message: `No data snapshot of the switch to ${target.from}: only the release can be rolled back (data kept).` }, 409);
  }
  const snapAt = snapshot ? act.status(deps.dataDir).snapshots.find((s) => s.id === snapshot)?.createdAt ?? null : null;
  const actor = await deps.ownerAction(ctx, {
    action: 'admin.change', level: 'fresh',
    payload: { op: 'release.rollback', from: target.from, to: target.to, restoreData, snapshot, confirmInsecure: confirmInsecure ?? null },
    title: `Roll AuraOS back to ${target.to}`,
    details: [
      `From ${target.from} to ${target.to}; the rolled-back release cannot be rolled back again (no previous).`,
      restoreData ? `The data snapshot from ${snapAt ?? 'the switch'} is restored: every change since then is lost (kept aside in the snapshot directory).` : 'Your data is kept as it is now.',
    ],
    highRisk: [
      ...(restoreData ? [{ item: `Data since ${snapAt ?? 'the switch'} is lost`, why: 'you chose to restore the data snapshot (Q35)', added: true }] : []),
      ...(sec.advisories.length ? [{ item: `Brings back fixed vulnerabilities: ${sec.advisories.join(', ')}`, why: 'a newer signed security update fixed them', added: true }] : []),
    ],
  });
  if (actor instanceof Response) return actor;
  const res = await deps.plannedRestart({ mode: 'rollback', restoreData, ...(confirmInsecure ? { confirmInsecure } : {}) });
  await deps.audit(actor, sec.advisories.length ? RELEASE_AUDIT.rollbackInsecure : RELEASE_AUDIT.rollback, {
    target: 'system', outcome: res.ok ? 'ok' : 'failed',
    detail: { ...target, restoreData, snapshot, ...(sec.advisories.length ? { advisories: sec.advisories } : {}), ...(res.ok ? {} : { reason: res.error }) },
  });
  return res.ok ? json({ ok: true, job: res.job, ...target, restoreData }, 202) : json({ ok: false, error: 'rollback-refused', message: res.error }, 409);
}

// ── accept writes ───────────────────────────────────────────────────────────

/**
 * Step 10: the updater's operator ticket accepts the writes of the release it
 * verified. The owner may accept only an ABANDONED hold (no job behind it,
 * `fresh`): "roll back (restores data) or accept".
 */
export async function postAcceptWrites(ctx: RouteCtx, deps: ReleaseAdminDeps, body: { jobId?: unknown }): Promise<Response> {
  const principal = await deps.authenticate(ctx.request);
  if (principal instanceof Response) return principal;
  const act = await deps.activation();
  const marker = act.readWritesHeld(deps.dataDir);
  let actor: OwnerActor | null = null;
  if (principal.kind === 'operator') {
    if (marker?.jobId && typeof body.jobId === 'string' && body.jobId !== marker.jobId) {
      return json({ ok: false, error: 'not-this-job', message: `the held release belongs to job ${marker.jobId}` }, 409);
    }
    actor = { by: core.operatorAttribution(), detail: {} };
  } else {
    const held = heldState(deps, marker);
    if (!held?.abandoned) {
      return json({ ok: false, error: 'operator-only', message: 'Writes are accepted by the updater once the release is healthy; the owner decides only after an activation was abandoned.' }, 403);
    }
    const a = await deps.ownerAction(ctx, {
      action: 'admin.change', level: 'fresh', payload: { op: 'release.accept-writes', jobId: marker?.jobId ?? null, to: marker?.to ?? null },
      title: `Keep release ${marker?.to ?? 'the running release'} and accept changes`,
      details: ['The last activation stopped before AuraOS checked the new release. Accept keeps it (and every change from now on); roll back instead to restore the release and data from before the switch.'],
    });
    if (a instanceof Response) return a;
    actor = a;
  }
  act.releaseHold(deps.dataDir);
  deps.acceptWrites();
  const ptr = act.status(deps.dataDir).pointer;
  const cur = ptr?.current ? act.readRelease(deps.dataDir, ptr.current) : null;
  const prev = ptr?.previous ? act.readRelease(deps.dataDir, ptr.previous) : null;
  await deps.audit(actor, principal.kind === 'operator' ? RELEASE_AUDIT.activated : RELEASE_AUDIT.acceptedByOwner, {
    target: 'system', detail: { release: ptr?.current ?? null, previous: ptr?.previous ?? null, jobId: marker?.jobId ?? null, snapshot: marker?.snapshot ?? null },
  });
  // Step 11 (owner question h): changed system apps get onUpdate (M); the Terminal and
  // keepRunningOnBuild apps only when the owner chose `now` (D35). Detached: the updater waits for nobody.
  const job = marker?.jobId ? deps.updater().readJob(marker.jobId) : null;
  const apps = act.changedApps(prev, cur);
  if (apps.length) void deps.switchSystemApps(apps, job?.when === 'now' ? 'now' : 'next-start').catch((err) => console.warn(`[release] switching system apps failed: ${(err as Error).message}`));
  return json({ ok: true, release: ptr?.current ?? null, acceptingWritesAt: new Date().toISOString(), switchedApps: apps });
}

// ── the boot report ─────────────────────────────────────────────────────────

/**
 * At boot (a server hook): a finished release job is audited and announced
 * once (`reported`), and a hold with no job behind it is announced as
 * abandoned: the owner chooses "roll back (restores data) or accept".
 */
export async function reportReleaseJobs(deps: ReleaseAdminDeps): Promise<void> {
  const updater = deps.updater();
  const job = updater.readJob();
  if (job && (job.mode === 'release' || job.mode === 'rollback') && job.finishedAt && !job.reported) {
    const file = join(deps.dataDir, 'aura', 'update', `${job.id}.json`);
    const failed = job.phase !== 'done';
    if (job.phase === 'rolled-back') {
      await deps.audit(null, RELEASE_AUDIT.rolledBack, { target: 'system', outcome: 'failed', detail: { jobId: job.id, from: job.fromRelease, to: job.toRelease, reason: job.error ?? null, automatic: true } });
      await deps.notify('Release update rolled back', `${job.toRelease} did not become healthy (${job.error ?? 'see the update log'}). ${job.fromRelease} and its data are back.`);
    } else if (failed) {
      await deps.audit(null, RELEASE_AUDIT.activationFailed, { target: 'system', outcome: 'failed', detail: { jobId: job.id, mode: job.mode, reason: job.error ?? null } });
      await deps.notify(job.mode === 'rollback' ? 'Release rollback failed' : 'Release activation failed', job.log[job.log.length - 1] ?? 'See Settings → About for the update log.');
    }
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      writeFileSync(file, JSON.stringify({ ...stored, reported: new Date().toISOString() }, null, 2));
    } catch { /* best effort */ }
  }
  const act = await deps.activation().catch(() => null);
  const held = heldState(deps, act ? act.readWritesHeld(deps.dataDir) : null);
  if (held?.abandoned) {
    await deps.notify('A release activation was interrupted',
      `AuraOS runs ${held.marker.to ?? 'the new release'} with changes held: the activation stopped before it was checked. In Settings → About, roll back (restores the release and data from before the switch) or accept it.`);
  }
}

// ── the 7b seam: ReleaseActivator ───────────────────────────────────────────

/**
 * Release activation for Phase 7b's system patches (`systemPatches.ts`
 * `ReleaseActivator`). The approval is the caller's (`system.patch.activate`
 * binds the release); this starts the same drain + updater `release` job. The
 * shell restarts during it, so the promise cannot carry the final outcome:
 * it resolves `{ ok: true, jobId }` once the job runs; the outcome is the job
 * (`phase` done / rolled-back / failed) and the audit the boot report writes.
 */
export interface ReleaseActivation {
  activate(input: { releaseId: string; jobId?: string; endsSessions: string[]; when: 'now' | 'next-start' }): Promise<{ ok: boolean; rolledBack?: boolean; reason?: string; jobId?: string; pending?: boolean }>;
}

export function releaseActivator(deps: ReleaseAdminDeps): ReleaseActivation {
  return {
    async activate({ releaseId, when }) {
      if (deps.developerMode()) return { ok: false, reason: DEVELOPER_MODE_RELEASE };
      const t = deps.trustedTree();
      if (!t) return { ok: false, reason: 'this install does not run from a release' };
      const act = await deps.activation();
      const pre = act.preflight(deps.dataDir, { id: releaseId, trustedTree: t, channel: await deps.channel() });
      // A system-patch release is locally modified by design: the channel rule is the base release's (7b binds it).
      const blockers = pre.blockers.filter((b) => b.code !== 'channel-downgrade');
      if (blockers.length) return { ok: false, reason: blockers.map((b) => b.message).join('; ') };
      const res = await deps.plannedRestart({ mode: 'release', releaseId, when });
      if (!res.ok) return { ok: false, reason: res.error };
      return { ok: true, pending: true, jobId: (res.job as { id?: string } | null)?.id };
    },
  };
}

// ── live dependencies ───────────────────────────────────────────────────────

const ACTIVATE_MODULE = 'os/release/activate.mjs';

export function liveReleaseDeps(): ReleaseAdminDeps {
  const dataDir = process.env['AURA_DATA_DIR'] ?? '/data';
  const L = core.releasePaths.dataLayout();
  const trustedTree = (): string | null => {
    const p = readJson<{ current?: string }>(L.pointer);
    if (!p?.current || !core.releasePaths.RELEASE_ID_RE.test(p.current)) return null;
    const dir = L.release(p.current);
    return existsSync(join(dir, '.complete')) ? dir : null;
  };
  const policyValue = async (id: string, fallback: string): Promise<string> => {
    try {
      const store = core.getAuthServices().securityPolicy;
      if (!store) return fallback;
      return String(core.securityPolicyValue(await store.get(), id));
    } catch { return fallback; }
  };
  return {
    dataDir,
    developerMode: isDeveloperMode,
    activation: async () => {
      const base = trustedTree() ?? process.env['AURA_WORKSPACE_DIR'] ?? '/workspace';
      return await import(/* @vite-ignore */ pathToFileURL(join(base, ACTIVATE_MODULE)).href) as ActivationModule;
    },
    trustedTree,
    updater: () => new core.SelfUpdater(dataDir),
    channel: async () => ((await policyValue(core.UPDATE_CHANNEL, 'signed')) === 'main' ? 'main' : 'signed'),
    securityPolicy: async () => ((await policyValue(core.SECURITY_UPDATE_POLICY, 'follow-signed')) === 'hold' ? 'hold' : 'follow-signed'),
    authenticate: async (request) => (await import('../auth.ts')).authenticate(request),
    ownerAction: (ctx, req) => ownerAction(ctx, req),
    audit: (actor, action, opts) => auditOwner(actor, action, opts),
    plannedRestart: async (opts) => (await import('../plannedRestart.js')).plannedRestart(opts),
    incompatibleApps: (auraContract) => {
      if (auraContract === null) return [];
      try {
        return core.getAppManager().getManifests()
          .filter((m) => typeof m.auraContract === 'number' && Math.floor(m.auraContract) > auraContract)
          .map((m) => m.id);
      } catch { return []; }
    },
    acceptWrites: () => core.getSystem()?.acceptWrites(),
    switchSystemApps: async (appIds, when) => {
      const out = await (await import('../appBuilds.js')).switchSystemAppsToRelease(appIds, when);
      console.log(`[release] system apps on the new release: ${out.map((o) => `${o.appId}${o.restarted ? ' restarted' : o.restartNote ? ` (${o.restartNote})` : ''}`).join(', ')}`);
    },
    notify: async (title, text) => {
      try {
        await core.getNotificationService().create(
          { type: 'simple', title, text } as Parameters<ReturnType<typeof core.getNotificationService>['create']>[0], core.SYSTEM_CALLER);
      } catch { console.warn(`[release] ${title}: ${text}`); }
    },
  };
}
