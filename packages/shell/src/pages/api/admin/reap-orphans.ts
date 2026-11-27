import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { auditOwner, ownerAction } from '../../../lib/approvals/admin.ts';
import { reapOrphansRequest } from '../../../lib/approvals/maintenance.ts';

interface AppProc { pid: number; appId: string; cmdline: string; }
interface ReapReport {
  trackedInstances: Array<{ instanceId: string; appId: string; port: number | null; pid: number | null; state: string }>;
  trackedPids: number[];
  appProcesses: AppProc[];
  squatters: AppProc[];
  killed: number[];
  errors: string[];
}

/**
 * POST /api/admin/reap-orphans[?dryRun=1]: the owner's (lib/approvals/maintenance.ts).
 * A dry run is a read; the kill one click from the System Terminal.
 */
export const POST: APIRoute = async (ctx) => {
  const dryRun = ctx.url.searchParams.get('dryRun') === '1';
  const actor = await ownerAction(ctx, reapOrphansRequest(dryRun));
  if (actor instanceof Response) return actor;
  const mgr = getAppManager();
  const tracked = mgr.getAllInstances();

  // The kernel's tracked pids (instance records plus every runtime's in-flight ones) and the app processes
  // no tracked one reaches, from the runtimes that scan their process space (5b-2 D-#11).
  const scan = mgr.orphanScan();
  const all = scan.all;
  const squatters = scan.squatters;

  const report: ReapReport = {
    trackedInstances: tracked.map((i) => ({
      instanceId: i.instanceId, appId: i.appId, port: i.port, pid: i.pid, state: i.state,
    })),
    trackedPids: scan.trackedPids,
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
    await auditOwner(actor, 'os.reap-orphans', {
      outcome: report.errors.length ? 'failed' : 'ok', detail: { killed: report.killed.length, errors: report.errors.length },
    });
  }

  return new Response(JSON.stringify(report, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
