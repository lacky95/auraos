/**
 * `aura admin homes …` and `aura admin identity …` (Phase 5 streams I and H).
 * Registered once under `aura admin` (Stage 1), so the streams add their
 * commands here and touch no registry.
 *
 * Stream I (5-pre2) adds the read-only reports only:
 *
 *   aura admin homes plan                    each instance's /home/aura against the Home Resolver's target
 *   aura admin homes ownership --dry-run     what stream H would chown (P5-2): rows, counts, digest
 *   aura admin homes import-report           what each app may want from the shared home (Q15)
 *   aura admin identity check                the uid registry and account invariants (by id only)
 *
 * They change nothing. Like every `aura admin` read, the System Terminal asks
 * the owner; on the host the operator reads directly.
 *
 * Stream H (5-main) adds the owner's changes, each approved with the password
 * (fresh) and audited:
 *
 *   aura admin homes ownership --apply <digest>      the reviewed dry run, journaled
 *   aura admin homes ownership --revert <journal>    restore one apply exactly (stream T's deploy recovery)
 *   aura admin homes import <app> <path...> [--apply] [--personal] [--user <id>]
 *                                            copy from your Private Home into the App Home (dry run first)
 *   aura admin homes reset <app> [--user <id>]       the App Home starts empty at the next start
 */
import type { Command } from 'commander';
import { api } from '../lib/client.js';
import { color, fail, info, ok, table, warn } from '../lib/format.js';

async function read<T>(path: string): Promise<T> {
  try {
    return await api.get<T>(path);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 404) fail('this shell has no Phase 5 identity reports yet.');
    fail(e.message);
  }
}

async function change<T>(path: string, body: unknown): Promise<T> {
  try {
    return await api.post<T>(path, body);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 404 && /\/api\/admin\/(homes|identity)/.test(path)) fail(e.message || 'this shell has no Phase 5 home operations yet.');
    fail(e.message);
  }
}

const json = (o: unknown) => console.log(JSON.stringify(o, null, 2));
const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)}G` : b >= 1e6 ? `${(b / 1e6).toFixed(1)}M` : b >= 1e3 ? `${(b / 1e3).toFixed(1)}k` : `${b}`);

interface Row { path: string; kind: string; from: string | null; to: string | null; exists: boolean; files: number; bytes: number; toChange: number; rootOwnedGit?: number; only?: string; note?: string; truncated?: true }
interface OwnershipReport {
  digest: string; planned: Row[]; plannedUserPaths: Row[]; plannedAppPaths: Row[]; reportOnly: Row[];
  refused: Array<{ path: string; reason: string }>; findings: string[];
}

function printOwnership(r: OwnershipReport): void {
  const rows = (list: Row[]) => list.map((x) => ({
    PATH: x.path, KIND: x.kind, FROM: x.from ?? '-', TO: x.to ?? '(not allocated)', FILES: x.exists ? x.files : '-',
    SIZE: x.exists ? size(x.bytes) : '-', CHANGE: x.exists ? `${x.toChange}${x.truncated ? '+' : ''}` : '-',
  }));
  for (const [title, list] of [
    ['Planned (homes, workspaces)', r.planned], ['Planned user paths (P5-2)', r.plannedUserPaths],
    ['Planned app paths (with each runAs flip, P5-3)', r.plannedAppPaths], ['Report only (never changed)', r.reportOnly],
  ] as const) {
    if (!list.length) continue;
    console.log(color.bold(title));
    console.log(table(rows(list)));
  }
  console.log(color.bold('Refused'));
  for (const x of r.refused) console.log(`  ${x.path}: ${x.reason}`);
  for (const f of r.findings) warn(f);
  info(`digest ${r.digest} (a dry run: nothing was changed)`);
}

export function registerAdminHomes(admin: Command): void {
  const homes = admin.command('homes').description('Private Homes and App Homes (Phase 5): reports, the ownership apply, import and reset.');

  homes
    .command('plan')
    .description('Per running instance: the /home/aura it runs with against the Home Resolver\'s target (an instance started by an earlier release shows the move it makes at its next start).')
    .option('-o, --output <format>', 'json')
    .action(async (opts: { output?: string }) => {
      const r = await read<{ rows: Array<{ instanceId: string; appId: string; executionContext: string; current: string; target: { kind: string; hostPath: string | null } | null; change: string; denied?: string }>; summary: Record<string, number> }>('/api/admin/homes/plan');
      if (opts.output === 'json') { json(r); return; }
      console.log(table(r.rows.map((x) => ({
        INSTANCE: x.instanceId, APP: x.appId, CONTEXT: x.executionContext, TODAY: x.current,
        TARGET: x.target ? `${x.target.kind} ${x.target.hostPath ?? '(tmpfs)'}` : `denied: ${x.denied}`, CHANGE: x.change,
      }))));
      info(`same ${r.summary['same'] ?? 0}, moves ${r.summary['moves'] ?? 0}, denied ${r.summary['denied'] ?? 0}`);
    });

  homes
    .command('ownership')
    .description('The ownership report (P5-2): --dry-run shows what would be chowned, row by row; --apply <digest> applies exactly that report. Never a blanket chown.')
    .option('--dry-run', 'the report only; changes nothing')
    .option('--apply <digest>', 'apply the report you reviewed (its digest), journaled; asks for your password')
    .option('--revert <journal>', 'restore one apply exactly from its journal (the name --apply printed); asks for your password')
    .option('-o, --output <format>', 'json')
    .action(async (opts: { dryRun?: boolean; apply?: string; revert?: string; output?: string }) => {
      if ([opts.dryRun, opts.apply, opts.revert].filter(Boolean).length !== 1) {
        fail('say which: aura admin homes ownership --dry-run, --apply <digest> after reviewing it, or --revert <journal>');
      }
      if (opts.revert) {
        const r = await change<{ journal: string; restored: number; skipped: string[] }>('/api/admin/identity/ownership-revert', { journal: opts.revert });
        if (opts.output === 'json') { json(r); return; }
        for (const x of r.skipped) warn(`not restored: ${x}`);
        ok(`reverted ${r.journal}: ${r.restored} entr${r.restored === 1 ? 'y' : 'ies'} restored`);
        return;
      }
      if (opts.apply) {
        const r = await change<{ changed: boolean; journal?: string; rows: Array<{ path: string; kind: string; changed: number; skipped: number }>; notApplied: Array<{ path: string; reason: string }> }>(
          '/api/admin/identity/ownership-apply', { digest: opts.apply });
        if (opts.output === 'json') { json(r); return; }
        if (r.rows.length) console.log(table(r.rows.map((x) => ({ PATH: x.path, KIND: x.kind, CHANGED: x.changed, SKIPPED: x.skipped }))));
        for (const x of r.notApplied) info(`not applied: ${x.path}: ${x.reason}`);
        if (r.journal) ok(`applied; journal ${r.journal}`);
        else ok('nothing to change');
        return;
      }
      const r = await read<OwnershipReport>('/api/admin/identity/ownership-report');
      if (opts.output === 'json') { json(r); return; }
      printOwnership(r);
    });

  homes
    .command('import-report')
    .description('What each installed app may want from your Private Home (the shared home before App Homes, Q15). Personal logins are marked; nothing is copied.')
    .option('-o, --output <format>', 'json')
    .action(async (opts: { output?: string }) => {
      const r = await read<{ home: string; installations: Array<{ appId: string; candidates: Array<{ path: string; source: string; files: number; bytes: number; personal?: string[]; note?: string }> }> }>('/api/admin/homes/import-report');
      if (opts.output === 'json') { json(r); return; }
      info(`home: ${r.home}`);
      for (const inst of r.installations) {
        if (!inst.candidates.length) continue;
        console.log(color.bold(inst.appId));
        console.log(table(inst.candidates.map((c) => ({
          PATH: c.path, FROM: c.source, FILES: c.files, SIZE: size(c.bytes), PERSONAL: c.personal?.length ? 'yes' : '',
        }))));
        for (const c of inst.candidates) if (c.note) warn(`${c.path}: ${c.note}`);
      }
    });

  homes
    .command('import <appId> <paths...>')
    .description('Copy paths (relative to your home, e.g. .claude.json) from your Private Home into the app\'s App Home (Q15). A dry run unless --apply. Copies, never moves; never overwrites.')
    .option('--apply', 'copy (asks for your password; the app must be stopped)')
    .option('--personal', 'include personal logins (ssh keys, Claude/gh/glab credentials): the app can then act with them; a fresh login in the app is preferred (D66)')
    .option('--user <userId>', 'the user whose App Home (a user-scope app); default: you')
    .option('-o, --output <format>', 'json')
    .action(async (appId: string, paths: string[], opts: { apply?: boolean; personal?: boolean; user?: string; output?: string }) => {
      const r = await change<{ apply: boolean; kind: string; target: string; items: Array<{ path: string; action: string; files: number; bytes: number; skipped: string[] }>; copiedFiles: number; copiedBytes: number }>(
        '/api/admin/homes/import', { appId, paths, apply: !!opts.apply, includePersonal: !!opts.personal, ...(opts.user ? { userId: opts.user } : {}) });
      if (opts.output === 'json') { json(r); return; }
      console.log(table(r.items.map((i) => ({ PATH: i.path, ACTION: i.action, FILES: i.files, SIZE: size(i.bytes), 'LEFT OUT': i.skipped.length || '' }))));
      for (const i of r.items) for (const x of i.skipped.slice(0, 10)) warn(x);
      if (r.items.some((i) => i.action === 'personal')) info('personal logins are left out; --personal copies them (prefer a fresh login in the app)');
      if (r.apply) ok(`copied ${r.copiedFiles} file(s), ${size(r.copiedBytes)} into the ${r.kind} App Home`);
      else info(`dry run: ${r.copiedFiles} file(s), ${size(r.copiedBytes)} would be copied; add --apply to copy`);
    });

  homes
    .command('reset <appId>')
    .description('Delete the app\'s App Home: it starts empty at the next start. The app must be stopped. Your Private Home and the app data are not touched.')
    .option('--user <userId>', 'the user whose App Home (a user-scope app); default: you')
    .action(async (appId: string, opts: { user?: string }) => {
      const r = await change<{ kind: string; removed: boolean }>('/api/admin/homes/reset', { appId, ...(opts.user ? { userId: opts.user } : {}) });
      ok(r.removed ? `reset the ${r.kind} App Home of ${appId}` : `${appId} had no ${r.kind} App Home yet`);
    });

  const identity = admin.command('identity').description('Linux identities and accounts (Phase 5): read-only checks in this release.');
  identity
    .command('check')
    .description('The uid/gid registry and the account invariants (by id only; never a hash or a username).')
    .option('-o, --output <format>', 'json')
    .action(async (opts: { output?: string }) => {
      const r = await read<{
        registry: { users: number; apps: number; ownerUid: number | null; findings: string[] };
        accounts: { users: number; owners: number; members: number; disabled: number; findings: string[] };
        enabledWithoutIdentity: string[]; auditUsernameTargets: number;
      }>('/api/admin/identity/check');
      if (opts.output === 'json') { json(r); return; }
      info(`registry: ${r.registry.users} user and ${r.registry.apps} app identities; owner uid ${r.registry.ownerUid ?? '(not allocated)'}`);
      info(`accounts: ${r.accounts.users} (${r.accounts.owners} owner, ${r.accounts.members} member, ${r.accounts.disabled} disabled)`);
      const findings = [
        ...r.registry.findings, ...r.accounts.findings,
        ...r.enabledWithoutIdentity.map((id) => `user:${id}: enabled without a Linux identity`),
        ...(r.auditUsernameTargets ? [`${r.auditUsernameTargets} audit entries name a user by something other than its id`] : []),
      ];
      for (const f of findings) warn(f);
      if (!findings.length) ok('the identity registry and the accounts hold');
      else process.exitCode = 1;
    });
}
