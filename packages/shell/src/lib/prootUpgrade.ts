/**
 * `POST /api/admin/upgrade-proot[?force=1]`: build a newer PRoot from source
 * into the running master (`/usr/local/bin/proot`, ahead of Debian's
 * `/usr/bin/proot` on PATH).
 *
 * Why: the Debian proot has known EFAULT issues with Rust-compiled native
 * modules (Tailwind 4 Oxide, jiti's bundled bindings, ...); upstream
 * `proot-me/proot` fixes many, but is in no Debian release.
 *
 * It builds and installs code as root in the master, so (SF-2 review, the
 * shared gate lib/privilegedExec.ts): argv only, verified apt for the build
 * dependency, the owner's password (`fresh`) bound to the source and ref, and
 * an audit entry. Reporting an existing build (no `force`) needs nobody.
 * The upstream ref is not pinned (it never was): the approval names it.
 */
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { json } from './approvals/service.ts';
import { aptInstallArgv, aptUpdateArgv, auditPrivileged, livePrivilegedDeps, privilegedAction, type PrivilegedDeps } from './privilegedExec.ts';

export const PROOT_SOURCE = 'https://github.com/proot-me/proot';
export const PROOT_REF = 'master';
export const PROOT_UPGRADE_OP = 'master.proot-upgrade';
const SRC = '/tmp/proot-src';
const BIN = '/usr/local/bin/proot';

type Ctx = Parameters<PrivilegedDeps['ownerAction']>[0] & { url: URL };

export interface ProotUpgradeDeps extends PrivilegedDeps {
  exists(path: string): boolean;
  baseRootfs: string;
}

export function liveProotUpgradeDeps(): ProotUpgradeDeps {
  return { ...livePrivilegedDeps(), exists: existsSync, baseRootfs: process.env['AURA_BASE_ROOTFS'] ?? '/os/base-rootfs' };
}

const versionLine = (out: string) => out.split('\n').find((l) => /^proot.*v/i.test(l.trim()))?.trim() ?? out.split('\n')[0] ?? '';

export async function postProotUpgrade(ctx: Ctx, deps: ProotUpgradeDeps = liveProotUpgradeDeps()): Promise<Response> {
  const force = ctx.url.searchParams.get('force') === '1';
  const log: Record<string, string> = {};

  if (!force && deps.exists(BIN)) {
    try {
      log['version_local'] = versionLine(deps.run(BIN, ['--version'], { timeoutMs: 10_000 }));
      log['note'] = 'already installed — pass ?force=1 to rebuild';
      return json({ ok: true, log });
    } catch { /* rebuild if the version check fails */ }
  }

  const actor = await privilegedAction(deps, ctx, {
    operation: PROOT_UPGRADE_OP, bind: { source: PROOT_SOURCE, ref: PROOT_REF, force }, level: 'fresh',
    title: 'Build and install PRoot from source in the master',
    details: [`Source: ${PROOT_SOURCE} (${PROOT_REF}, not pinned)`, `Installs ${BIN} as root; every PRoot app uses it.`],
  });
  if (actor instanceof Response) return actor;

  try {
    try { deps.run('dpkg', ['-s', 'libtalloc-dev'], { timeoutMs: 5_000 }); log['talloc'] = 'present'; }
    catch {
      deps.run(aptUpdateArgv()[0]!, aptUpdateArgv().slice(1), { timeoutMs: 120_000 });
      log['apt_install'] = deps.run('apt-get', aptInstallArgv(['libtalloc-dev']).slice(1), { timeoutMs: 120_000 });
    }
    if (deps.exists(SRC)) {
      deps.run('git', ['-C', SRC, 'fetch', 'origin'], { timeoutMs: 60_000 });
      log['git_pull'] = deps.run('git', ['-C', SRC, 'reset', '--hard', `origin/${PROOT_REF}`], { timeoutMs: 60_000 });
    } else {
      log['git_clone'] = deps.run('git', ['clone', '--depth', '1', '--branch', PROOT_REF, '--', PROOT_SOURCE, SRC], { timeoutMs: 120_000 });
    }
    try { deps.run('make', ['clean'], { timeoutMs: 60_000, cwd: `${SRC}/src` }); } catch { /* a fresh tree has nothing to clean */ }
    log['build'] = deps.run('make', [`-j${Math.max(1, cpus().length)}`], { timeoutMs: 180_000, cwd: `${SRC}/src` }).split('\n').slice(-8).join('\n');
    deps.run('install', ['-m', '0755', `${SRC}/src/proot`, BIN], { timeoutMs: 10_000 });
    log['installed_at'] = BIN;
    log['version_new'] = versionLine(deps.run(BIN, ['--version'], { timeoutMs: 10_000 }));
    try { deps.run(BIN, [`--rootfs=${deps.baseRootfs}`, '/bin/true'], { timeoutMs: 10_000 }); log['smoke_test'] = 'rc=0'; }
    catch (err) { log['smoke_test'] = (err as Error).message.slice(0, 300); }
  } catch (err) {
    await auditPrivileged(deps, actor, PROOT_UPGRADE_OP, { target: `file:${BIN}`, outcome: 'failed', detail: { source: PROOT_SOURCE, ref: PROOT_REF, force }, error: (err as Error).message });
    return json({ ok: false, error: (err as Error).message, log }, 500);
  }
  await auditPrivileged(deps, actor, PROOT_UPGRADE_OP, { target: `file:${BIN}`, outcome: 'ok', detail: { source: PROOT_SOURCE, ref: PROOT_REF, force, version: log['version_new'] } });
  return json({ ok: true, log });
}
