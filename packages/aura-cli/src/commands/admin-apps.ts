/**
 * `aura admin apps …` (Phase 5 stream A, P5-3): how installed apps' processes run.
 *
 *   aura admin apps privileges [-o json]      the privilege review: per installation its runAs,
 *                                             app identity, last app start, verdict and every
 *                                             "needs elevated privileges" reason
 *   aura admin apps run-as <app> app|root     flip one installation (your password; applies to
 *                                             its next start). `root` is the per-app rollback.
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
    .description('Run one installed app as its own app identity (app) or as root (the per-app rollback). Needs your password; applies to its next start.')
    .argument('<app>', 'the app id')
    .argument('<mode>', 'app | root')
    .action(async (appId: string, mode: string) => {
      if (mode !== 'app' && mode !== 'root') fail('mode must be app or root');
      let r: { changed: boolean; runAs: string; running?: number };
      try { r = await api.post('/api/admin/apps/run-as', { appId, runAs: mode }); }
      catch (err) { fail(`run-as: ${refusal(err)}`); }
      if (!r.changed) { ok(`${appId} already runs as ${r.runAs}`); return; }
      ok(`${appId} now runs as ${r.runAs} from its next start`);
      if (r.running) info(`restart it to apply: aura restart app ${appId}`);
    });
}
