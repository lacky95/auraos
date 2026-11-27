/**
 * The PRoot module's orphan scan (5b-2 D-#11): app processes in the master's
 * process space that no tracked process owns. PRoot apps run in this space
 * (the master placement), so the module owns the scan; the kernel's
 * reconciler and the owner's `reap-orphans` route only decide what to do with
 * the result. One implementation (it was in both the reconciler and the
 * route). Only cmdlines naming an app dir under `apps/` of the system scope
 * qualify, so a user debugging inside `aura exec inst` is never a squatter.
 */
import { readdirSync, readFileSync } from 'node:fs';
import type { RuntimeOrphanProcess, RuntimeOrphans } from '../ari.js';

function parentOf(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
    const m = status.match(/^PPid:\s+(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

/** Every app process here (the app id without a `-N` instance suffix). */
function appProcesses(): RuntimeOrphanProcess[] {
  const out: RuntimeOrphanProcess[] = [];
  let pids: string[];
  try { pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n)); }
  catch { return out; }
  for (const pidStr of pids) {
    let cmdline = '';
    try { cmdline = readFileSync(`/proc/${pidStr}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim(); }
    catch { continue; }
    const m = cmdline.match(/apps\/(com\.aura\.[a-z.]+(?:-\d+)?)/);
    if (!m) continue;
    out.push({ pid: Number(pidStr), appId: (m[1] ?? '').replace(/-\d+$/, ''), cmdline });
  }
  return out;
}

export const prootOrphans: RuntimeOrphans = {
  scan(tracked) {
    const reachesTracked = (pid: number): boolean => {
      let cur: number | null = pid;
      const seen = new Set<number>();
      while (cur != null && !seen.has(cur)) {
        if (tracked.has(cur)) return true;
        seen.add(cur);
        cur = parentOf(cur);
      }
      return false;
    };
    const all = appProcesses();
    return { all, squatters: all.filter((p) => !reachesTracked(p.pid)) };
  },
};
