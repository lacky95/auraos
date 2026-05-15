import type { APIRoute } from 'astro';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';

/**
 * One-shot installer for "the base-rootfs essentials every proot ships with".
 *
 * The Dockerfile's base-rootfs stage already installs these at image build —
 * but that requires `docker compose up --build`. This endpoint applies the
 * same set to a RUNNING container's base-rootfs so we don't have to rebuild
 * every time the canonical list changes. Idempotent: apt-get skips packages
 * that are already present, so calling this twice is harmless.
 *
 * Mechanism: chroot into /os/base-rootfs and run apt-get there. The
 * base-rootfs is a complete Debian filesystem with its own apt config, so
 * this is cleaner than copying binaries + libs out of the container
 * (no library-version drift, config files end up in /etc/*, etc.).
 *
 * resolv.conf is copied in first so DNS works inside the chroot — the
 * snapshot from image build time has none.
 */

const ESSENTIALS = [
  'openssh-client',
  'openssh-server',
  'nano',
  'less',
  'htop',
  'lsof',
  'dnsutils',
  'iproute2',
];

function sh(cmd: string, opts: Parameters<typeof execSync>[1] = {}): string {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString().trim();
}

export const POST: APIRoute = async ({ request }) => {
  const baseRootfs = process.env['AURA_BASE_ROOTFS'] ?? '/os/base-rootfs';
  if (!existsSync(baseRootfs)) {
    return new Response(JSON.stringify({ error: `base-rootfs not found: ${baseRootfs}` }), { status: 500 });
  }

  // Optional payload to override the package list (e.g. for ad-hoc additions).
  let body: { packages?: string[] } = {};
  try { body = await request.json(); } catch { /* empty body is fine */ }
  const packages = (body.packages && body.packages.length > 0) ? body.packages : ESSENTIALS;

  const log: string[] = [];
  try {
    // 1. Ensure DNS works inside the chroot. base-rootfs's /etc/resolv.conf
    //    is whatever Debian snapshot shipped — usually empty or stale. Copy
    //    the container's live resolv.conf in.
    const resolvDst = join(baseRootfs, 'etc', 'resolv.conf');
    mkdirSync(dirname(resolvDst), { recursive: true });
    if (existsSync('/etc/resolv.conf')) {
      copyFileSync('/etc/resolv.conf', resolvDst);
      log.push('staged /etc/resolv.conf for chroot DNS');
    }

    // 2. apt-get update inside the chroot. Some Debian images can't verify
    //    signatures without gnupg/apt-key; allow insecure if needed so the
    //    initial bootstrap doesn't deadlock waiting on a chicken/egg dep.
    const aptEnv = 'DEBIAN_FRONTEND=noninteractive';
    log.push(sh(`${aptEnv} chroot ${baseRootfs} apt-get update -qq -o Acquire::AllowInsecureRepositories=true 2>&1`, { timeout: 60_000 }));

    // 3. Install the package set.
    log.push(sh(
      `${aptEnv} chroot ${baseRootfs} apt-get install -y -q --no-install-recommends --allow-unauthenticated ${packages.join(' ')} 2>&1`,
      { timeout: 300_000 },
    ));

    return new Response(JSON.stringify({ ok: true, baseRootfs, packages, log }, null, 2), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message, log }, null, 2), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};
