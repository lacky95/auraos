/**
 * `aura admin apps …` (Phase 5 stream A, P5-3): how installed apps' processes run.
 *
 *   aura admin apps privileges [-o json]      the privilege review: per installation its runAs,
 *                                             app identity, last app start, verdict and every
 *                                             "needs elevated privileges" reason
 *   aura admin apps run-as <app> app|root     the dry run of a flip: when the uid changes, the data
 *                                             migration it needs (rows, counts, digest)
 *   aura admin apps run-as <app> app|root --apply <digest>
 *                                             the flip (your password): stops the app, migrates its
 *                                             data journaled, flips, starts it again. `root` is the
 *                                             per-app rollback; it restores the earlier migration.
 *   aura admin apps run-as <app> --recover    restore an unfinished migration from its journal
 *
 * A failed `app` start is never retried as root: it fails, visibly.
 */
import type { Command } from 'commander';
import { api, type ShellError } from '../lib/client.js';
import { color, fail, info, ok, table, warn } from '../lib/format.js';

interface ReviewRow {
  appId: string; scope: string; installationId: string | null; runAs: 'root' | 'app' | null;
  identity: { uid: number; gid: number } | null; verdict: string; elevated: string[]; mismatched: string[];
  migration: { wave: number | string; expect: string; note: string } | null;
  instances: Array<{ instanceId: string; uid: number | null }>;
  /** app | session-host | approved-root | legacy-root | not-approved | unrecorded (owner decision 5-main item 3). */
  execution?: string;
  lastAppStart?: { at: string; ok: boolean; error?: string };
}
interface Review { rows: ReviewRow[]; summary: Record<string, number> }

function refusal(err: unknown): string {
  const body = (err as ShellError).body;
  if (body) {
    try {
      const b = JSON.parse(body) as { message?: string; error?: string };
      return b.message ?? b.error ?? body;
    } catch { return body; }
  }
  return (err as Error).message;
}

const VERDICT: Record<string, (s: string) => string> = {
  app: color.green, ready: (s) => s, 'needs-review': color.yellow, blocked: color.yellow, root: color.dim,
  'approved-root': color.yellow, 'not-approved': color.red,
};

export function registerAdminApps(admin: Command): void {
  const apps = admin.command('apps').description('How installed apps run: their own non-root app identity or root (P5-3).');

  apps
    .command('privileges')
    .description('The privilege review: per installation its runAs, app uid, last app start and what it would need beyond a non-root process.')
    .option('-o, --output <format>', 'json')
    .action(async (opts: { output?: string }) => {
      let r: Review;
      try { r = await api.get<Review>('/api/admin/identity/privilege-review'); }
      catch (err) {
        if ((err as ShellError).status === 404) fail('this shell has no privilege review yet (Phase 5, 5-apps).');
        fail(refusal(err));
      }
      if (opts.output === 'json') { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(table(r.rows.map((x) => ({
        APP: x.appId, SCOPE: x.scope, 'RUN AS': x.runAs ?? '-',
        UID: x.identity ? x.identity.uid : '-',
        WAVE: x.migration ? String(x.migration.wave) : '-',
        VERDICT: (VERDICT[x.verdict] ?? ((s: string) => s))(x.verdict),
        'LAST APP START': x.lastAppStart ? (x.lastAppStart.ok ? 'ok' : color.yellow('failed')) : '-',
      }))));
      for (const x of r.rows) {
        for (const e of x.elevated) console.log(`  ${x.appId}: ${e}`);
        if (x.mismatched.length) warn(`${x.appId}: instance(s) not running as recorded: ${x.mismatched.join(', ')} (restart them)`);
        if (x.lastAppStart && !x.lastAppStart.ok) warn(`${x.appId}: last app start failed: ${x.lastAppStart.error ?? ''}`);
      }
      info(Object.entries(r.summary).map(([k, v]) => `${k} ${v}`).join(', '));
    });

  apps
    .command('run-as')
    .description('Run one installed app as its own app identity (app) or as root (the per-app rollback). When its uid changes, its data, App Homes and dev caches move with it: a dry run first, then --apply <digest> (your password) stops it, migrates, flips and starts it again.')
    .argument('<app>', 'the app id')
    .argument('[mode]', 'app | root')
    .option('--apply <digest>', 'apply the dry run you reviewed (its digest), journaled; asks for your password')
    .option('--recover', 'restore an unfinished run-as change exactly from its journal; asks for your password')
    .option('-o, --output <format>', 'json')
    .action(async (appId: string, mode: string | undefined, opts: { apply?: string; recover?: boolean; output?: string }) => {
      if (opts.recover) {
        if (mode || opts.apply) fail('--recover takes only the app');
        let r: { changed: boolean; message?: string; restored?: number; skipped?: string[]; journal?: string; runAs?: string };
        try { r = await api.post('/api/admin/apps/run-as', { appId, recover: true }); }
        catch (err) { fail(`run-as --recover: ${refusal(err)}`); }
        if (opts.output === 'json') { console.log(JSON.stringify(r, null, 2)); return; }
        if (!r.changed) { ok(r.message ?? `${appId} has no unfinished run-as change`); return; }
        for (const x of r.skipped ?? []) warn(`not restored: ${x}`);
        ok(`restored ${r.journal}: ${r.restored} entr${r.restored === 1 ? 'y' : 'ies'}; ${appId} still runs as ${r.runAs} and is stopped`);
        info(`start it again (aura start app ${appId}) or run the change again (aura admin apps run-as ${appId} <mode>)`);
        return;
      }
      if (mode !== 'app' && mode !== 'root') fail('mode must be app or root');
      if (opts.apply !== undefined && !/^[0-9a-f]{64}$/.test(opts.apply)) fail('--apply takes the digest the dry run printed');
      let r: RunAsAnswer;
      try { r = await api.post('/api/admin/apps/run-as', { appId, runAs: mode, ...(opts.apply ? { digest: opts.apply } : {}) }); }
      catch (err) {
        const body = (err as ShellError).body;
        let parsed: { error?: string; digest?: string } = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch { /* plain text */ }
        if (parsed.error === 'digest-mismatch' && parsed.digest) warn(`the new dry run's digest: ${parsed.digest}`);
        fail(`run-as: ${refusal(err)}`);
      }
      if (opts.output === 'json') { console.log(JSON.stringify(r, null, 2)); return; }
      if (r.dryRun && r.plan) {
        printPlan(r.plan);
        if (r.running) info(`${r.running} running instance(s): stopped before the change, started again after it succeeded`);
        info(`a dry run: nothing was changed. Apply exactly this: aura admin apps run-as ${appId} ${mode} --apply ${r.plan.digest}`);
        return;
      }
      if (!r.changed) { ok(`${appId} already runs as ${r.runAs}`); return; }
      if (r.journal) {
        if (r.rows?.length) console.log(table(r.rows.map((x) => ({ PATH: x.path, KIND: x.kind, CHANGED: x.changed, SKIPPED: x.skipped }))));
        if (r.restored) info(`restored exactly from the earlier migration: ${r.restored.restored} (left alone: ${r.restored.skipped})`);
        ok(`${appId} now runs as ${r.runAs}; journal ${r.journal}`);
        for (const e of r.restartFailed ?? []) warn(`not started again: ${e}`);
        if (r.restarted) info(`started again: ${r.restarted} instance(s)`);
        return;
      }
      ok(`${appId} now runs as ${r.runAs} from its next start`);
      if (r.running) info(`restart it to apply: aura restart app ${appId}`);
    });
}

interface PlanRow { path: string; kind: string; from: string | null; to: string | null; onlyFrom?: string; exists: boolean; files: number; toChange: number; truncated?: true }
interface RunAsPlan {
  from: string; to: string; rows: PlanRow[]; refused: Array<{ path: string; reason: string }>; findings: string[];
  restore: { journal: string; entries: number } | null; digest: string;
}
interface RunAsAnswer {
  changed: boolean; runAs: string; running?: number; dryRun?: boolean; plan?: RunAsPlan; journal?: string;
  rows?: Array<{ path: string; kind: string; changed: number; skipped: number }>; restored?: { restored: number; skipped: number };
  restarted?: number; restartFailed?: string[];
}

function printPlan(p: RunAsPlan): void {
  info(`its storage moves from ${p.from} to ${p.to}; only entries ${p.from} owns change, everything else keeps its owner`);
  console.log(table(p.rows.map((x) => ({
    PATH: x.path, KIND: x.kind, NOW: x.from ?? '-', FILES: x.exists ? x.files : '-', CHANGE: x.exists ? `${x.toChange}${x.truncated ? '+' : ''}` : '(missing)',
  }))));
  if (p.restore) info(`first restored exactly from ${p.restore.journal}: ${p.restore.entries} entr${p.restore.entries === 1 ? 'y' : 'ies'}`);
  for (const x of p.refused) warn(`refused: ${x.path}: ${x.reason}`);
  for (const f of p.findings) warn(f);
  info(`digest ${p.digest}`);
}
