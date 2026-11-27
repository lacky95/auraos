import type { Command } from 'commander';
import { api, type ShellError } from '../lib/client.js';
import { color, fail, ok } from '../lib/format.js';

/**
 * The system mode (D30, D60; shell lib/systemMode.ts). Docs: developer-mode.
 *
 *   aura mode                          show the mode, what differs in /workspace, workspace mounts
 *   aura mode developer                turn Developer Mode on: your password in the desktop's
 *                                      dialog, or directly on the host (D12)
 *   aura mode normal [--move-to-branch]  turn it off: the clean-tree flow
 *   aura mode export-patches           save what differs as patch files
 *
 *   aura dev rebuild | restart         Developer Mode: build what changed and restart / restart
 */

type Mode = 'normal' | 'developer';
interface Tree {
  git: boolean;
  branch: string | null;
  head: string | null;
  release: { ref: string; commit: string } | null;
  uncommitted: string[];
  untracked: string[];
  localCommits: Array<{ sha: string; subject: string }>;
  counts: { uncommitted: number; untracked: number; localCommits: number };
  clean: boolean;
}
interface ModeState {
  mode: Mode;
  configured: Mode | null;
  env: Mode | null;
  default: Mode;
  normalEnforced: boolean;
  /** The release AuraOS runs from (the Normal layout, Phase 6 L); null in the Developer layout. */
  release?: ReleaseView | null;
  workspaceMounts?: Array<{ instanceId: string; containerPath: string }>;
  tree?: Tree;
}
export interface ReleaseView {
  id: string; commit: string | null; version: string | null; channel: string | null;
  provenance: string | null; signed: boolean; keyId: string | null; previous: string | null;
}
interface Refusal { error?: string; message?: string; hint?: string; tree?: Tree; recommend?: Array<{ step: string; what: string }> }

const ROUTE = '/api/admin/system-mode';
const LIST = 15;

function refusalOf(err: unknown): Refusal | null {
  const body = (err as ShellError).body;
  if (!body) return null;
  try { return JSON.parse(body) as Refusal; } catch { return null; }
}

function printTree(t: Tree): void {
  if (!t.git) { console.log(color.dim('  /workspace is not a git checkout')); return; }
  console.log(`  checkout:   ${t.branch ?? '(detached)'} ${color.dim(t.head?.slice(0, 12) ?? '')}`);
  console.log(`  release:    ${t.release ? `${t.release.ref} ${color.dim(t.release.commit.slice(0, 12))}` : color.yellow('unknown (the remote main was never fetched)')}`);
  if (t.clean) { console.log(`  tree:       ${color.green('clean')} (nothing differs from the release)`); return; }
  const section = (title: string, n: number, items: string[]) => {
    if (!n) return;
    console.log(`  ${title} (${n}):`);
    for (const i of items.slice(0, LIST)) console.log(`    ${i}`);
    if (n > LIST) console.log(color.dim(`    … ${n - LIST} more`));
  };
  section('uncommitted changes', t.counts.uncommitted, t.uncommitted);
  section('untracked files', t.counts.untracked, t.untracked);
  section(`local commits not in ${t.release?.ref ?? 'the release'}`, t.counts.localCommits, t.localCommits.map((c) => `${c.sha} ${c.subject}`));
}

/** The release line (D34): `<version> <commit7>, previous <id>`. */
export function releaseLine(r: ReleaseView): string {
  return `release ${r.version ?? r.id}${r.commit ? ` ${r.commit.slice(0, 7)}` : ''}${r.previous ? `, previous ${r.previous}` : ''}`;
}
/** Channel and provenance; never "signed" unless the release is maintainer-signed (D71, owner answer a). */
export function provenanceLine(r: ReleaseView): string {
  const trust = r.signed ? color.green(`signed${r.keyId ? ` (key ${r.keyId})` : ''}`) : color.yellow('not maintainer-signed');
  return `channel ${r.channel ?? '-'}, ${r.provenance ?? 'unknown provenance'}, ${trust}`;
}
/** Where system changes go in Normal Mode (D34, D68). */
export const SYSTEM_CHANGES = 'aura system patch start | save | activate (D68): the release itself is read-only';

async function show(): Promise<void> {
  const s = await api.get<ModeState>(`${ROUTE}?tree=1`);
  const enforced = s.normalEnforced && s.release;
  console.log(`mode:       ${s.mode === 'developer' ? color.yellow('developer') : color.green('normal')}${enforced ? ` (${releaseLine(s.release!)})` : s.env ? color.dim(' (AURA_SYSTEM_MODE on the container)') : s.configured ? '' : color.dim(' (default)')}`);
  if (enforced) {
    console.log(`release:    ${provenanceLine(s.release!)}`);
    console.log(`changes:    ${SYSTEM_CHANGES}`);
    return;
  }
  if (s.mode === 'normal') {
    console.log(color.dim('            Normal mode is recorded only: this install runs from its /workspace checkout (the Developer layout).'));
  }
  for (const m of s.workspaceMounts ?? []) console.log(`  workspace mount: ${m.instanceId} ${color.dim(m.containerPath)} (read-write)`);
  if (s.tree) printTree(s.tree);
}

async function setMode(mode: Mode, moveToBranch: boolean): Promise<void> {
  let s: ModeState & { detached?: string[]; cleanup?: { branch: string; mainBranch?: string; backup: string } };
  try {
    s = await api.put(ROUTE, { mode, ...(moveToBranch ? { cleanup: 'branch' } : {}) });
  } catch (err) {
    const r = refusalOf(err);
    if (r?.error === 'tree-not-clean' && r.tree) {
      console.error(`${color.yellow('!')} Developer Mode stays on: ${r.message ?? '/workspace differs from the release.'}`);
      printTree(r.tree);
      console.error('\nRecommended, in this order:');
      for (const step of r.recommend ?? []) console.error(`  (${step.step}) ${step.what}`);
      process.exit(1);
    }
    fail(`mode: ${r?.message ?? r?.error ?? (err as Error).message}${r?.hint ? `\n  Fix: ${r.hint}` : ''}`);
  }
  if (s!.env && s!.env !== mode) console.log(color.yellow(`  Note: AURA_SYSTEM_MODE=${s!.env} on the container wins over this setting.`));
  if (mode === 'developer') {
    ok('Developer Mode is on. aura dev rebuild|restart and aura mount workspace (in the System Terminal) are available.');
    return;
  }
  if (s!.cleanup) {
    console.log(`  Your work is on branch ${color.bold(s!.cleanup.branch)}${s!.cleanup.mainBranch ? ` (and main's own on ${s!.cleanup.mainBranch})` : ''}; backup: ${s!.cleanup.backup} (kept 30 days).`);
  }
  if (s!.detached?.length) console.log(`  Detached the workspace mount from ${s!.detached.join(', ')}.`);
  if (s!.normalEnforced) { ok('AuraOS runs from a release: Normal mode already.'); return; }
  ok('Developer Mode is off (normal). This install keeps running from its /workspace checkout; the locked release is the Normal layout (install.sh).');
}

async function exportPatches(): Promise<void> {
  const r = await api.post<{ dir: string | null; files: string[]; message?: string }>(ROUTE, { action: 'export-patches' });
  if (!r.dir) { ok(r.message ?? 'Nothing to save.'); return; }
  ok(`Saved ${r.files.length} file(s) to ${color.bold(r.dir)}`);
  for (const f of r.files) console.log(`  ${f}`);
}

export function registerSystemMode(program: Command): void {
  program
    .command('mode [mode]')
    .description('Show or switch the system mode: developer (AuraOS runs from /workspace, you develop it) or normal. Also: export-patches.')
    .option('--move-to-branch', 'Switching off with a tree that differs: move everything to a dev/<date> branch, keep a 30-day backup, reset to the release (asks for your password)')
    .addHelpText('after', [
      '',
      'Examples:',
      '  aura mode                          # the mode and what differs in /workspace',
      '  aura mode developer                # on: confirm with your password in the desktop (on the host: directly)',
      '  aura mode export-patches           # save your changes to /data/aura/dev-patches/<date>/',
      '  aura mode normal                   # off: refused while /workspace differs from the release',
      '  aura mode normal --move-to-branch  # off, with the automatic clean-up',
      '',
      'Normal mode is enforced when AuraOS runs from a release (the Normal layout): the release is read-only,',
      'system changes go through aura system patch (D68). In a checkout (the Developer layout) it is recorded only.',
    ].join('\n'))
    .action(async (mode: string | undefined, opts: { moveToBranch?: boolean }) => {
      try {
        if (mode === undefined) return await show();
        if (mode === 'export-patches') return await exportPatches();
        if (mode !== 'developer' && mode !== 'normal') fail(`mode must be developer, normal or export-patches (got '${mode}')`);
        if (opts.moveToBranch && mode !== 'normal') fail('--move-to-branch applies to aura mode normal');
        await setMode(mode, opts.moveToBranch === true);
      } catch (err) {
        fail(`mode: ${(err as Error).message}`);
      }
    });
}

/** `aura dev rebuild` / `aura dev restart` (D32, D60), registered on `aura dev`. */
export function registerDevRestart(dev: Command): void {
  const run = async (build: boolean, restore: boolean) => {
    let r: { ok: boolean; activities?: number; error?: string };
    try {
      r = await api.post('/api/admin/dev/restart', { build, restore });
    } catch (err) {
      const x = refusalOf(err);
      fail(`dev ${build ? 'rebuild' : 'restart'}: ${x?.message ?? x?.error ?? (err as Error).message}`);
    }
    ok(`AuraOS is ${build ? 'building what changed and restarting' : 'restarting'} — ${restore
      ? `your work is saved (${r!.activities ?? 0} activities) and comes back`
      : 'it comes back with an empty desktop'}.`);
    console.log(color.dim('  This shell connection drops for a moment; the desktop reloads by itself.'));
  };
  dev
    .command('rebuild')
    .description('Developer Mode: build the packages whose sources changed in /workspace, then restart AuraOS (desktop saved).')
    .option('--no-restore', 'Come back with an empty desktop')
    .action(async (opts: { restore?: boolean }) => run(true, opts.restore !== false));
  dev
    .command('restart')
    .description('Developer Mode: restart AuraOS without building (desktop saved).')
    .option('--no-restore', 'Come back with an empty desktop')
    .action(async (opts: { restore?: boolean }) => run(false, opts.restore !== false));
}
