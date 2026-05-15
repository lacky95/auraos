import type { APIRoute } from 'astro';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Debug helper — report the PRoot binary in use, its version, and a smoke
 *  test using `--kernel-release=4.4.0` against the base-rootfs. */
export const GET: APIRoute = () => {
  function sh(cmd: string): string {
    try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).toString().trim(); }
    catch (e) { return `<error: ${(e as Error).message.slice(0, 200)}>`; }
  }
  const baseRootfs = process.env['AURA_BASE_ROOTFS'] ?? '/os/base-rootfs';
  return new Response(JSON.stringify({
    which:           sh('which proot'),
    version:         sh('proot --version 2>&1 | head -3'),
    aptVersion:      sh('dpkg-query -W -f="${Version}" proot 2>/dev/null'),
    smoke_default:   sh(`proot --rootfs=${baseRootfs} /bin/true 2>&1; echo rc=$?`),
    smoke_kernel44:  sh(`proot --kernel-release=4.4.0 --rootfs=${baseRootfs} /bin/true 2>&1; echo rc=$?`),
    has_newer_local: existsSync('/usr/local/bin/proot') ? sh('/usr/local/bin/proot --version 2>&1 | head -3') : 'not present',
  }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
