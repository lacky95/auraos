import type { APIRoute } from 'astro';
import { execSync } from 'node:child_process';

/** Debug: report base-rootfs size and a sample of its dirs. */
export const GET: APIRoute = () => {
  const baseRootfs = process.env['AURA_BASE_ROOTFS'] ?? '/os/base-rootfs';
  function sh(cmd: string): string {
    try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).toString().trim(); }
    catch (e) { return `<error: ${(e as Error).message}>`; }
  }
  return new Response(JSON.stringify({
    baseRootfs,
    duMiB: sh(`du -sm ${baseRootfs} 2>/dev/null`),
    libDirSize: sh(`du -sh ${baseRootfs}/usr/lib/x86_64-linux-gnu 2>/dev/null`),
    libCount: sh(`ls ${baseRootfs}/usr/lib/x86_64-linux-gnu 2>/dev/null | wc -l`),
    bashrc: sh(`head -20 ${baseRootfs}/root/.bashrc 2>/dev/null`),
    auraDir: sh(`ls -la ${baseRootfs}/aura 2>/dev/null`),
    bash_v: sh(`${baseRootfs}/usr/bin/bash --version 2>&1 | head -1`),
    htop_check: sh(`ldd ${baseRootfs}/usr/bin/htop 2>&1 | grep -i 'not found\\|=>' | head -10`),
    basics_present: sh(`for f in ssh sshd nano htop lsof nslookup curl less ip dig; do
        for d in /usr/bin /usr/sbin /bin /sbin; do
          if [ -x "${baseRootfs}$d/$f" ]; then echo "$f $d/$f"; break; fi
        done
      done`),
    runningInstancesCount: sh('ps -ef | grep -E "proot|astro" | grep -v grep | wc -l'),
    auraToolsRuntime: sh(`du -sh /data/aura/runtime/ 2>/dev/null`),
  }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
