/**
 * `aura admin homes …` and `aura admin identity …` (Phase 5 streams I and H).
 * Registered once under `aura admin` (Stage 1), so the streams add their
 * commands here and touch no registry.
 *
 * Stream I (5-pre2) adds the read-only reports only:
 *
 *   aura admin homes plan                    today's /home/aura per instance against the Phase 5 target
 *   aura admin homes ownership --dry-run     what stream H would chown (P5-2): rows, counts, digest
 *   aura admin homes import-report           what each app may want from the shared home (Q15)
 *   aura admin identity check                the uid registry and account invariants (by id only)
 *
 * They change nothing. Like every `aura admin` read, the System Terminal asks
 * the owner; on the host the operator reads directly. Stream H adds `apply`,
 * `import` and `reset` (5-main).
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
  const homes = admin.command('homes').description('Private Homes and App Homes (Phase 5): read-only reports in this release.');

  homes
    .command('plan')
    .description('Per running instance: today\'s /home/aura source against the Phase 5 target (report mode; mounts nothing).')
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
    .description('The dry-run ownership report (P5-2): what would be chowned, row by row. Never a blanket chown; never changes anything.')
    .option('--dry-run', 'required in this release: the report only')
    .option('-o, --output <format>', 'json')
    .action(async (opts: { dryRun?: boolean; output?: string }) => {
      if (!opts.dryRun) fail('only the dry run exists in this release: aura admin homes ownership --dry-run');
      const r = await read<OwnershipReport>('/api/admin/identity/ownership-report');
      if (opts.output === 'json') { json(r); return; }
      printOwnership(r);
    });

  homes
    .command('import-report')
    .description('What each installed app may want from today\'s shared home (Q15). Personal logins are marked; nothing is copied.')
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
