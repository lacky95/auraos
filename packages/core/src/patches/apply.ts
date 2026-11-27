/**
 * Applying patches in order with `git am --3way` (Phase 7b). PORTABLE (see
 * `seriesFile.ts`): node builtins and types only, so the kernel
 * (`series.ts` `applySeries`) and the release builder's series step
 * (`os/release/series-slot.mjs`) run the same code. It validates nothing:
 * the callers run `validatePatch` on every enabled patch first.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ApplyResult, SeriesPatch } from './types.js';

export interface AmOptions {
  /** Leave the work tree mid-`git am` at a conflict, for repair. */
  keepConflict?: boolean;
  /** Extra args before `-C <dir>` (e.g. `-c safe.directory=<dir>`). */
  gitArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}

const BASE_ENV = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });

function lastLines(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const text = (e.stderr ? e.stderr.toString() : '') || e.message || String(err);
  return text.trim().split('\n').filter(Boolean).slice(-3).join(' ');
}

/**
 * Apply the ENABLED patches onto the work tree's HEAD, one commit each.
 * Stops at the first patch that does not apply and names it (0-based index
 * in the full list); it is backed out unless `keepConflict`.
 */
export function amApply(workTree: string, patches: Array<SeriesPatch & { content: string }>, opts: AmOptions = {}): ApplyResult {
  const env = opts.env ?? BASE_ENV();
  const run = (args: string[]): string => execFileSync('git', [...(opts.gitArgs ?? []), '-C', workTree, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeout ?? 120_000, env, maxBuffer: 64 * 1024 * 1024,
  }).toString();
  const tryRun = (args: string[]): string | null => { try { return run(args); } catch { return null; } };
  const id = tryRun(['config', 'user.email'])?.trim() ? [] : ['-c', 'user.name=Aura', '-c', 'user.email=aura@aura.local'];
  const active = patches.map((p, index) => ({ p, index })).filter(({ p }) => p.enabled !== false);
  const dir = mkdtempSync(join(tmpdir(), 'aura-apply-'));
  try {
    for (let n = 0; n < active.length; n++) {
      const { p, index } = active[n]!;
      const file = join(dir, basename(p.file));
      writeFileSync(file, p.content);
      try {
        run([...id, 'am', '-q', '--3way', '--keep-cr', file]);
      } catch (err) {
        const conflicts = (tryRun(['diff', '--name-only', '--diff-filter=U']) ?? '').split('\n').filter(Boolean);
        const message = lastLines(err);
        if (!opts.keepConflict) tryRun([...id, 'am', '--abort']);
        const { content: _c, ...meta } = p;
        return { ok: false, applied: n, failed: { ...meta, index }, conflicts, message, inProgress: !!opts.keepConflict };
      }
    }
    return { ok: true, applied: active.length, head: run(['rev-parse', 'HEAD']).trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
