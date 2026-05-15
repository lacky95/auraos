import type { APIRoute } from 'astro';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Build a newer PRoot from source into the running container.
 *
 * Why: the Debian-shipped proot has known EFAULT issues with Rust-compiled
 * native modules (Tailwind 4 Oxide, jiti's bundled bindings, etc.). The
 * upstream `proot-me/proot` repo fixes many of these — but it's not in any
 * Debian release. We build from source against the container's libtalloc
 * and install to /usr/local/bin/proot, which takes precedence over the
 * apt-installed /usr/bin/proot via the default PATH order.
 *
 * Idempotent: re-running just reports the already-installed version unless
 * `?force=1`. The build takes ~20-30s on first run, ~5s on re-runs (talloc
 * cached, git fetch updates only).
 */
function sh(cmd: string, timeoutMs = 120_000): string {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs }).toString().trim();
}

export const POST: APIRoute = ({ url }) => {
  const force = url.searchParams.get('force') === '1';
  const log: Record<string, string> = {};

  // 0. Short-circuit if already installed (unless forced).
  if (!force && existsSync('/usr/local/bin/proot')) {
    try {
      log['version_local'] = sh('/usr/local/bin/proot --version 2>&1 | grep -i "^[Pp]root.*v" | head -1');
      log['note'] = 'already installed — pass ?force=1 to rebuild';
      return new Response(JSON.stringify({ ok: true, log }, null, 2), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    } catch { /* re-build if version check fails */ }
  }

  try {
    // 1. Ensure libtalloc-dev is present (PRoot's only build-time dep besides gcc/make).
    try { sh('dpkg -s libtalloc-dev', 5_000); log['talloc'] = 'present'; }
    catch {
      log['apt_install'] = sh('apt-get update -qq && apt-get install -y -q --no-install-recommends libtalloc-dev', 120_000);
    }

    // 2. Clone fresh (or fetch updates) into /tmp/proot-src.
    const src = '/tmp/proot-src';
    if (existsSync(src)) {
      log['git_pull'] = sh(`cd ${src} && git fetch origin && git reset --hard origin/master 2>&1`, 60_000);
    } else {
      log['git_clone'] = sh(`git clone --depth 1 https://github.com/proot-me/proot ${src} 2>&1`, 120_000);
    }

    // 3. Build. PRoot's makefile lives in src/, output is src/proot.
    log['build'] = sh(`cd ${src}/src && make clean >/dev/null 2>&1; make -j$(nproc) 2>&1 | tail -8`, 180_000);

    // 4. Install. /usr/local/bin precedes /usr/bin so this version wins by PATH order.
    sh(`install -m 0755 ${src}/src/proot /usr/local/bin/proot`);
    log['installed_at'] = '/usr/local/bin/proot';
    log['version_new'] = sh('/usr/local/bin/proot --version 2>&1 | grep -i "^[Pp]root.*v" | head -1');
    log['which_resolves_to'] = sh('which proot');

    // 5. Smoke test: spawn a no-op against base-rootfs.
    const baseRootfs = process.env['AURA_BASE_ROOTFS'] ?? '/os/base-rootfs';
    log['smoke_test'] = sh(`/usr/local/bin/proot --rootfs=${baseRootfs} /bin/true 2>&1; echo rc=$?`, 10_000);

    return new Response(JSON.stringify({ ok: true, log }, null, 2), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message, log }, null, 2), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};
