import type { APIRoute } from 'astro';
import { readFileSync, readdirSync } from 'node:fs';
import { getAppManager } from '@aura/core';

interface AppProc { pid: number; appId: string; cmdline: string; }
interface ReapReport {
  trackedInstances: Array<{ instanceId: string; appId: string; port: number | null; pid: number | null; state: string }>;
  trackedPids: number[];
  appProcesses: AppProc[];
  squatters: AppProc[];
  killed: number[];
  errors: string[];
}

function listAppProcesses(): AppProc[] {
  const out: AppProc[] = [];
  let pids: string[];
  try { pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n)); }
  catch { return out; }
  for (const pidStr of pids) {
    let cmdline = '';
    try { cmdline = readFileSync(`/proc/${pidStr}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim(); }
    catch { continue; }
    const m = cmdline.match(/apps\/(com\.aura\.[a-z.]+(?:-\d+)?)/);
    if (!m) continue;
    // Extract bare appId (strip any -N suffix when matching an instance dir)
    const appId = (m[1] ?? '').replace(/-\d+$/, '');
    out.push({ pid: Number(pidStr), appId, cmdline });
  }
  return out;
}

export const POST: APIRoute = async ({ url }) => {
  const dryRun = url.searchParams.get('dryRun') === '1';
  const mgr = getAppManager();
  const tracked = mgr.getAllInstances();

  // PIDs the AppManager knows about (the spawn returns the proot's pid).
  // Each proot has child processes (bash entrypoint, node astro). Those
  // children are NOT in tracked, so we also walk descendants of every
  // tracked pid and consider them tracked too.
  const trackedPids = new Set<number>();
  for (const t of tracked) if (t.pid != null) trackedPids.add(t.pid);
  // Walk /proc and accept any pid whose ancestor chain reaches a tracked pid.
  function getPPid(pid: number): number | null {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
      const m = status.match(/^PPid:\s+(\d+)/m);
      return m ? Number(m[1]) : null;
    } catch { return null; }
  }
  function reachesTracked(pid: number): boolean {
    let cur: number | null = pid;
    const seen = new Set<number>();
    while (cur != null && !seen.has(cur)) {
      if (trackedPids.has(cur)) return true;
      seen.add(cur);
      cur = getPPid(cur);
    }
    return false;
  }

  const all = listAppProcesses();
  const squatters = all.filter((p) => !reachesTracked(p.pid));

  const report: ReapReport = {
    trackedInstances: tracked.map((i) => ({
      instanceId: i.instanceId, appId: i.appId, port: i.port, pid: i.pid, state: i.state,
    })),
    trackedPids: Array.from(trackedPids),
    appProcesses: all,
    squatters,
    killed: [],
    errors: [],
  };

  if (!dryRun) {
    for (const s of squatters) {
      try { process.kill(s.pid, 'SIGKILL'); report.killed.push(s.pid); }
      catch (err) { report.errors.push(`kill ${s.pid}: ${(err as Error).message}`); }
    }
    // Tracked instance whose own pid is now dead → null the port so the proxy
    // stops routing to a now-vacant port. (The instance entry stays — we can't
    // reset the AppManager singleton from here.)
    for (const inst of tracked) {
      let alive = true;
      try { if (inst.pid) process.kill(inst.pid, 0); else alive = false; }
      catch { alive = false; }
      if (!alive) {
        inst.port = null;
        inst.state = 'error';
        inst.error = 'reaped by /api/admin/reap-orphans';
      }
    }
  }

  return new Response(JSON.stringify(report, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
