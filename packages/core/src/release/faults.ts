/**
 * Crash points for tests (Phase 7a, D64 option `test-fault-points`): an
 * activation step names its point, and when that point is armed the process
 * dies on the spot (SIGKILL), as a power cut or an OOM kill would. Used by
 * the e2e crash-recovery checks on a test VM; never a hidden switch.
 *
 * Armed only by `AURA_TEST_FAULT=<point>[,<point>]` under `NODE_ENV=test`, or
 * by `<dataDir>/aura/test-faults` (one point per line) when that file is owned
 * by root and not writable by others (the e2e tool writes it on a VM). A leaf.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const TEST_FAULTS_FILE = 'aura/test-faults';

export type FaultPoint =
  | 'installer:after-stage' | 'installer:after-carry' | 'installer:after-exchange' | 'installer:after-record';

export const FAULT_POINTS: readonly FaultPoint[] = ['installer:after-stage', 'installer:after-carry', 'installer:after-exchange', 'installer:after-record'];

/** The armed points (empty almost always). */
export function armedFaults(dataDir: string, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const out = new Set<string>();
  if (env['NODE_ENV'] === 'test') for (const p of (env['AURA_TEST_FAULT'] ?? '').split(',')) if (p.trim()) out.add(p.trim());
  const file = join(dataDir, TEST_FAULTS_FILE);
  try {
    const st = statSync(file);
    if (st.uid === 0 && (st.mode & 0o022) === 0) {
      for (const l of readFileSync(file, 'utf8').split('\n')) if (l.trim() && !l.startsWith('#')) out.add(l.trim());
    }
  } catch { /* not armed */ }
  return out;
}

/** At step `point`: when it is armed for `dataDir`, kill this process now. */
export function injectFault(dataDir: string, point: FaultPoint): void {
  if (!armedFaults(dataDir).has(point)) return;
  console.error(`[faults] ${point}: killing this process (test fault)`);
  process.kill(process.pid, 'SIGKILL');
}
