import type { Command } from 'commander';
import { api, type ShellError } from '../lib/client.js';
import { color, fail, ok } from '../lib/format.js';

/**
 * `aura release` (Phase 6 stream U): the locked releases of a Normal-mode
 * install (shell lib/release/releaseAdmin.ts, `/api/admin/release/**`).
 * Developer Mode answers with its own workflow: `aura update` (Settings →
 * About) fast-forwards /workspace and rebuilds; the owner manages git.
 *
 *   aura release status              current and previous release, channel, provenance, held state, last job
 *   aura release ls                  the releases on disk
 *   aura release build [ref]         build a release from the update channel (one click)
 *   aura release activate <id>       switch to a built release (the owner approves the exact release)
 *        [--now]                     end Terminal sessions now instead of on their next start (D35)
 *   aura release rollback            back to the previous release; data kept
 *        [--restore-data]            also restore the data snapshot of the switch (changes since are lost)
 *        [--confirm-insecure <ids>]  roll back past a (non-critical) security update, naming its advisories
 *   aura release accept              keep a release whose activation was interrupted (the owner, password)
 *   aura release job <id>            one build or activation job checklist
 */
interface ReleaseView {
  id: string; version: string | null; commit: string; channel: string; provenance: string;
  signed: boolean; securityUpdate: boolean; severity: string | null; composition: string; missing?: boolean;
}
interface Step { key: string; label: string; status: string; detail?: string }
interface Job { id: string; mode?: string; kind?: string; phase: string; error?: string; steps?: Step[]; fromRelease?: string; toRelease?: string }
interface Status {
  mode: 'normal' | 'developer';
  message?: string;
  channel?: string;
  securityPolicy?: string;
  pointer?: { current: string; previous: string | null; switchedAt: string } | null;
  current?: ReleaseView | null;
  previous?: ReleaseView | null;
  releases?: ReleaseView[];
  held?: { abandoned: boolean; marker: { jobId: string | null; to: string | null; at: string | null } } | null;
  snapshots?: Array<{ id: string; createdAt: string; toRelease: string }>;
  running?: boolean;
  job?: Job | null;
}

const provenanceText = (r: ReleaseView): string => (r.provenance === 'upstream-signed'
  ? color.green('signed upstream release')
  : r.provenance === 'locally-modified' ? color.yellow('locally modified, not a signed release') : color.yellow('unsigned (main channel)'));

function line(label: string, r: ReleaseView | null | undefined): void {
  if (!r) { console.log(`${label}none`); return; }
  if (r.missing) { console.log(`${label}${r.id} ${color.red('(missing or incomplete)')}`); return; }
  const sec = r.securityUpdate ? color.yellow(` security update${r.severity ? ` (${r.severity})` : ''}`) : '';
  console.log(`${label}${color.bold(r.version ?? 'main')} ${color.dim(r.commit.slice(0, 12))} ${provenanceText(r)}${sec} ${color.dim(r.id)}`);
}

function printJob(job: Job): void {
  console.log(`job ${job.id}: ${job.mode ?? job.kind ?? 'job'} ${job.phase}${job.error ? ` — ${job.error}` : ''}`);
  for (const s of job.steps ?? []) {
    const mark = s.status === 'done' ? color.green('✓') : s.status === 'failed' ? color.red('✗') : s.status === 'running' ? '…' : color.dim('·');
    console.log(`  ${mark} ${s.label}${s.detail ? color.dim(`  ${s.detail}`) : ''}`);
  }
}

const errText = (err: unknown): string => {
  const e = err as ShellError;
  try { const b = JSON.parse(e.body ?? '') as { message?: string; error?: string }; return b.message ?? b.error ?? e.message; } catch { return e.message; }
};

async function status(): Promise<void> {
  const s = await api.get<Status>('/api/admin/release');
  if (s.mode === 'developer' && !s.pointer) { console.log(`mode:      ${color.yellow('developer')}\n${color.dim(s.message ?? '')}`); return; }
  console.log(`channel:   ${s.channel}${s.channel === 'main' ? color.yellow(' (unsigned)') : ''}  security updates: ${s.securityPolicy}`);
  line('current:   ', s.current);
  line('previous:  ', s.previous);
  if (s.held) {
    console.log(s.held.abandoned
      ? color.red(`held:      the activation to ${s.held.marker.to ?? '?'} was interrupted before it was checked: run \`aura release rollback --restore-data\` (release and data from before the switch) or \`aura release accept\``)
      : color.yellow(`held:      verifying ${s.held.marker.to ?? 'the new release'}: changes are held until it is healthy`));
  }
  if (s.snapshots?.length) console.log(`snapshots: ${s.snapshots.map((x) => `${x.id} ${color.dim(x.createdAt)}`).join(', ')}`);
  if (s.job) printJob(s.job);
}

async function list(): Promise<void> {
  const s = await api.get<Status>('/api/admin/release');
  for (const r of s.releases ?? []) {
    const tag = r.id === s.pointer?.current ? color.green(' current') : r.id === s.pointer?.previous ? color.dim(' previous') : '';
    line('', r);
    if (tag) console.log(`  ${tag}`);
  }
  if (!s.releases?.length) console.log('no releases on disk');
}

export function registerRelease(program: Command): void {
  const release = program
    .command('release')
    .description('Locked releases of a Normal-mode install: status, build, activate, rollback (Phase 6).');
  release.command('status').description('The current and previous release, channel, provenance, held state and the last job.')
    .action(async () => { try { await status(); } catch (err) { fail(`release status: ${errText(err)}`); } });
  release.command('ls').description('The releases on disk.')
    .action(async () => { try { await list(); } catch (err) { fail(`release ls: ${errText(err)}`); } });
  release.command('build [ref]').description('Build a release from the update channel (the owner decides).')
    .option('--maturity <floor>', 'alpha | beta | stable (the signed channel\'s floor)')
    .action(async (ref: string | undefined, o: { maturity?: string }) => {
      try {
        const r = await api.post<{ job: string }>('/api/admin/release/build', { ...(ref ? { ref } : {}), ...(o.maturity ? { maturity: o.maturity } : {}) });
        ok(`Building a release (job ${r.job}); \`aura release job ${r.job}\` shows its progress, then \`aura release activate <id>\`.`);
      } catch (err) { fail(`release build: ${errText(err)}`); }
    });
  release.command('activate <id>').description('Switch to a built release (the owner approves the exact release).')
    .option('--now', 'end active Terminal sessions now instead of on their next start (D35)')
    .action(async (id: string, o: { now?: boolean }) => {
      try {
        const r = await api.post<{ job?: { id?: string } }>('/api/admin/release/activate', { releaseId: id, when: o.now ? 'now' : 'next-start' });
        ok(`Activating ${id} (job ${r.job?.id ?? '?'}): AuraOS restarts on it; changes are held until it is healthy, a failure rolls back automatically.`);
        console.log(color.dim('  This shell connection drops for a moment; `aura release status` shows the result.'));
      } catch (err) { fail(`release activate: ${errText(err)}`); }
    });
  release.command('rollback').description('Switch back to the previous release; restoring its data is a separate choice.')
    .option('--restore-data', 'also restore the data snapshot taken before the switch (changes since are lost)')
    .option('--confirm-insecure <advisories>', 'roll back past a non-critical security update, naming its advisories (comma-separated)')
    .action(async (o: { restoreData?: boolean; confirmInsecure?: string }) => {
      try {
        const r = await api.post<{ to: string }>('/api/admin/release/rollback', { restoreData: o.restoreData === true, ...(o.confirmInsecure ? { confirmInsecure: o.confirmInsecure } : {}) });
        ok(`Rolling back to ${r.to}${o.restoreData ? ' with the data snapshot' : ' (data kept)'}.`);
      } catch (err) { fail(`release rollback: ${errText(err)}`); }
    });
  release.command('accept').description('Keep a release whose activation was interrupted before it was checked (the owner decides).')
    .action(async () => {
      try { const r = await api.post<{ release: string }>('/api/admin/release/accept-writes', {}); ok(`Release ${r.release} kept; changes are accepted.`); }
      catch (err) { fail(`release accept: ${errText(err)}`); }
    });
  release.command('job <id>').description('One build or activation job checklist.')
    .action(async (id: string) => {
      try { printJob((await api.get<{ job: Job }>(`/api/admin/release/jobs/${encodeURIComponent(id)}`)).job); }
      catch (err) { fail(`release job: ${errText(err)}`); }
    });
}
