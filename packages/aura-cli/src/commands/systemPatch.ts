import type { Command } from 'commander';
import { api } from '../lib/client.js';
import { apiOrBody } from './dev-source.js';
import { color, fail, info, ok, warn } from '../lib/format.js';

/**
 * `aura system patch` (Phase 7b, D68): change AuraOS itself on a Normal-mode
 * install. The kernel does the work (`/api/admin/system-patches`); the CLI
 * is a client. Docs: system-patches.
 *
 *   aura system patch start [--base <release>] [--new]   a workspace at /mnt/aura/work/system
 *   aura system patch save [-m <message>]                  save its commits as a series revision
 *   aura system patch status | diff [rev]                  the state, the exact diff
 *   aura system patch disable|enable <patch>               a new revision with the flag changed
 *   aura system patch activate [rev] [--now]               validate (throwaway build), then the owner's
 *                                                          password approval of the exact diff, then build
 *                                                          and activate (atomic switch, health, rollback)
 */
const ROUTE = '/api/admin/system-patches';

type R = { ok?: boolean; error?: string; message?: string } & Record<string, unknown>;

function done(what: string, r: R): R {
  if (r.error) fail(`${what}: ${r.message ?? r.error}`);
  return r;
}

async function post(body: Record<string, unknown>): Promise<R> {
  return apiOrBody<R>(() => api.post(ROUTE, body));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls a builder job until it ends; prints its steps as they finish. */
async function follow(job: string): Promise<{ phase?: string; error?: string; code?: string; repair?: unknown; validated?: unknown }> {
  const seen = new Set<string>();
  for (;;) {
    const j = await apiOrBody<{ phase?: string; error?: string; code?: string; steps?: Array<{ key: string; label: string; status: string; detail?: string }> } & R>(
      () => api.get(`${ROUTE}?job=${encodeURIComponent(job)}`));
    for (const s of j.steps ?? []) {
      if ((s.status === 'done' || s.status === 'failed' || s.status === 'skipped') && !seen.has(s.key)) {
        seen.add(s.key);
        const line = `${s.label}${s.detail ? color.dim(` — ${s.detail}`) : ''}`;
        if (s.status === 'failed') warn(line); else info(`  ${s.status === 'skipped' ? color.dim('skip') : color.green('ok  ')} ${line}`);
      }
    }
    if (j.phase && j.phase !== 'running') return j;
    if (j.error === 'not-found') { await sleep(1000); continue; }
    await sleep(2000);
  }
}

export function registerSystemPatch(system: Command): void {
  const patch = system.command('patch').description('System patches: change AuraOS itself on a Normal-mode install (D68).');

  patch.command('start')
    .description('A writable checkout of the running release plus the active series, at /mnt/aura/work/system')
    .option('--base <release>', 'start from another release on this install (repair after an update)')
    .option('--new', 'a fresh workspace even when one exists')
    .action(async (o: { base?: string; new?: boolean }) => {
      const r = done('start', await post({ action: 'start', ...(o.base ? { base: o.base } : {}), ...(o.new ? { new: true } : {}) }));
      ok(`${r['created'] ? 'Created' : 'Reattached'} system workspace ${r['n']} at ${r['path']}`);
      const apply = r['apply'] as { ok: boolean; failed?: { file: string; subject: string }; conflicts?: string[] } | null;
      if (apply && !apply.ok) warn(`the active series stops at ${apply.failed?.file} ("${apply.failed?.subject}"): fix the conflicts${apply.conflicts?.length ? ` in ${apply.conflicts.join(', ')}` : ''}, then git am --continue`);
      info('Edit and commit there, then: aura system patch save -m "<what>"');
    });

  patch.command('save')
    .description('Save the workspace\'s commits as a new series revision (validated; nothing runs)')
    .option('-m, --message <text>', 'what this revision does')
    .action(async (o: { message?: string }) => {
      const r = done('save', await post({ action: 'save', ...(o.message ? { message: o.message } : {}) }));
      ok(r['changed'] ? `Saved revision ${String(r['rev']).slice(0, 12)} (${r['patches']} patch(es), digest ${String(r['digest']).slice(0, 12)})` : 'Nothing changed since the last save');
      info('Activate it (the owner approves the exact diff with the password): aura system patch activate');
    });

  patch.command('status')
    .description('The running release, its provenance and the series')
    .option('-o, --output <fmt>', 'json')
    .action(async (o: { output?: string }) => {
      const s = await api.get<R>(ROUTE);
      if (o.output === 'json') { console.log(JSON.stringify(s, null, 2)); return; }
      const rel = s['release'] as { line: string; id: string } | null;
      console.log(`Mode:      ${s['mode']}${s['available'] ? '' : color.dim(` — ${s['reason']}`)}`);
      if (rel) console.log(`Release:   ${rel.line} ${color.dim(rel.id)}`);
      const store = s['store'] as { head: string | null; active: string | null; approved: Array<{ n: number; rev: string }> };
      console.log(`Series:    ${store.head ? `head ${store.head.slice(0, 12)}` : 'no system patches'}${store.active ? `, active ${store.active.slice(0, 12)}` : ''}`);
      const series = s['series'] as { patches: Array<{ subject: string; file: string; enabled: boolean; flags: string[] }> } | null;
      for (const [i, p] of (series?.patches ?? []).entries()) {
        console.log(`  ${String(i + 1).padStart(2)}. ${p.enabled ? '' : color.yellow('[disabled] ')}${p.subject} ${color.dim(p.file)}${p.flags.length ? color.yellow(` (${p.flags.join('; ')})`) : ''}`);
      }
      const nr = s['needsRepair'] as { patch: { file: string; subject: string }; release: string | null; disabledIn?: string } | null;
      if (nr) warn(`needs repair: ${nr.patch.subject} (${nr.patch.file}) on ${nr.release ?? '?'}${nr.disabledIn ? ' — the update ran without it' : ''}. Repair: aura system patch start --base ${nr.release}`);
    });

  patch.command('diff [rev]')
    .description('The exact diff of a revision (default: the last saved)')
    .action(async (rev?: string) => {
      const r = done('diff', await apiOrBody<R>(() => api.get(`${ROUTE}?diff=${encodeURIComponent(rev ?? 'HEAD')}`)));
      process.stdout.write(String(r['diff'] ?? ''));
    });

  for (const what of ['disable', 'enable'] as const) {
    patch.command(`${what} <patch>`)
      .description(what === 'disable' ? 'A new revision without applying <patch> (number, file or sha256)' : 'A new revision applying <patch> again (needs the password)')
      .action(async (p: string) => {
        const r = done(what, await post({ action: what, patch: p }));
        ok(`${what}d ${r['file']}: revision ${String(r['rev']).slice(0, 12)}. Activate it to take effect: aura system patch activate`);
      });
  }

  patch.command('activate [rev]')
    .description('Validate in a throwaway build, then approve the exact diff (password), then build and activate')
    .option('--now', 'activate now even when Terminal sessions end (default: on the next start, D35)')
    .action(async (rev: string | undefined, o: { now?: boolean }) => {
      const v = done('validate', await post({ action: 'validate', ...(rev ? { rev } : {}) }));
      info(`Validating revision ${String(v['rev']).slice(0, 12)} (throwaway build, no privileges; job ${v['job']})`);
      const j = await follow(String(v['job']));
      if (j.phase !== 'validated') fail(`validation failed${j.code ? ` (${j.code})` : ''}: ${j.error ?? j.phase}`);
      ok('Validated. Asking the owner to approve the exact diff…');
      const a = done('activate', await post({ action: 'activate', job: v['job'], when: o.now ? 'now' : 'next-start' }));
      info(`Approved (${a['approved']}); building release ${a['release']} (job ${a['job']})`);
      const b = await follow(String(a['job']));
      if (b.phase !== 'done') fail(`the approved build failed${b.code ? ` (${b.code})` : ''}: ${b.error ?? b.phase}; the running release is unchanged`);
      ok(`Release ${a['release']} is built. Its activation (switch, health, automatic rollback) is recorded in the audit trail: aura system patch status`);
    });
}
