/**
 * The PRoot module's owner actions (5b PR, D100 §4 "runtime"): the mechanism
 * of `POST /api/admin/base-install` and `POST /api/admin/upgrade-proot`. The
 * route authorizes (owner action, approval bound to the payload) and audits
 * (D50, SF-1); the action only executes, by argv on the executor it is handed
 * (`RuntimeActionHost.run`, the shell's privileged runner), never through a
 * shell, with apt's signature checks forced on (D94 G8).
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { aptInstallArgv, aptUpdateArgv } from '../../capabilities/apt.js';
import type { RuntimeAction, RuntimeActionHost } from '../ari.js';
import { ensureChrootDevices } from './chrootDevices.js';

/** The executor of the PRoot actions; the chroot preparation and the file probe are replaceable (tests). */
export interface ProotActionHost extends RuntimeActionHost {
  /** Stages the master's resolv.conf into the chroot; returns whether it did. */
  stageResolvConf?(rootfs: string): boolean;
  /** Makes `<rootfs>/dev/{null,zero,random,urandom}` the right devices (fails closed); returns what it changed. */
  ensureDevices?(rootfs: string): string[];
  exists?(path: string): boolean;
}

export const PROOT_SOURCE = 'https://github.com/proot-me/proot';
export const PROOT_REF = 'master';
const SRC = '/tmp/proot-src';
export const PROOT_LOCAL_BIN = '/usr/local/bin/proot';

function stageResolvConf(rootfs: string): boolean {
  if (!existsSync('/etc/resolv.conf')) return false;
  const dst = join(rootfs, 'etc', 'resolv.conf');
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync('/etc/resolv.conf', dst);
  return true;
}

const versionLine = (out: string) => out.split('\n').find((l) => /^proot.*v/i.test(l.trim()))?.trim() ?? out.split('\n')[0] ?? '';

/** `version` (read-only), `baseInstall` and `upgrade` (mutating) over the base rootfs this module runs. */
export function prootOwnerActions(baseRootfs: string): Record<'version' | 'baseInstall' | 'upgrade', RuntimeAction> {
  const sh = (host: RuntimeActionHost) => host as ProotActionHost;
  return {
    version: {
      title: 'The locally built PRoot and its version',
      mutating: false,
      async run(_input, host) {
        if (!(sh(host).exists ?? existsSync)(PROOT_LOCAL_BIN)) return { installed: false };
        return { installed: true, version: versionLine(host.run(PROOT_LOCAL_BIN, ['--version'], { timeoutMs: 10_000 })) };
      },
    },
    baseInstall: {
      title: 'Install packages into the PRoot base system (apt, signatures verified)',
      mutating: true,
      async run(input, host) {
        const packages = input['packages'];
        if (!Array.isArray(packages) || !packages.every((p) => typeof p === 'string')) throw new Error('packages must be a list of package names');
        const h = sh(host);
        const log: string[] = [];
        try {
          if ((h.stageResolvConf ?? stageResolvConf)(baseRootfs)) log.push('staged /etc/resolv.conf for chroot DNS');
          log.push(...(h.ensureDevices ?? ((root: string) => ensureChrootDevices(root, host.run)))(baseRootfs));
          log.push(host.run('chroot', [baseRootfs, ...aptUpdateArgv()], { timeoutMs: 60_000 }));
          log.push(host.run('chroot', [baseRootfs, ...aptInstallArgv(packages as string[])], { timeoutMs: 300_000 }));
        } catch (err) {
          // What ran before the failure, for the caller's answer.
          throw Object.assign(err as Error, { log });
        }
        return { baseRootfs, packages, log };
      },
    },
    upgrade: {
      title: 'Build and install PRoot from source in the master',
      mutating: true,
      async run(_input, host) {
        const exists = sh(host).exists ?? existsSync;
        const log: Record<string, string> = {};
        try {
          try { host.run('dpkg', ['-s', 'libtalloc-dev'], { timeoutMs: 5_000 }); log['talloc'] = 'present'; }
          catch {
            host.run(aptUpdateArgv()[0]!, aptUpdateArgv().slice(1), { timeoutMs: 120_000 });
            log['apt_install'] = host.run('apt-get', aptInstallArgv(['libtalloc-dev']).slice(1), { timeoutMs: 120_000 });
          }
          if (exists(SRC)) {
            host.run('git', ['-C', SRC, 'fetch', 'origin'], { timeoutMs: 60_000 });
            log['git_pull'] = host.run('git', ['-C', SRC, 'reset', '--hard', `origin/${PROOT_REF}`], { timeoutMs: 60_000 });
          } else {
            log['git_clone'] = host.run('git', ['clone', '--depth', '1', '--branch', PROOT_REF, '--', PROOT_SOURCE, SRC], { timeoutMs: 120_000 });
          }
          try { host.run('make', ['clean'], { timeoutMs: 60_000, cwd: `${SRC}/src` }); } catch { /* a fresh tree has nothing to clean */ }
          log['build'] = host.run('make', [`-j${Math.max(1, cpus().length)}`], { timeoutMs: 180_000, cwd: `${SRC}/src` }).split('\n').slice(-8).join('\n');
          host.run('install', ['-m', '0755', `${SRC}/src/proot`, PROOT_LOCAL_BIN], { timeoutMs: 10_000 });
          log['installed_at'] = PROOT_LOCAL_BIN;
          log['version_new'] = versionLine(host.run(PROOT_LOCAL_BIN, ['--version'], { timeoutMs: 10_000 }));
          try { host.run(PROOT_LOCAL_BIN, [`--rootfs=${baseRootfs}`, '/bin/true'], { timeoutMs: 10_000 }); log['smoke_test'] = 'rc=0'; }
          catch (err) { log['smoke_test'] = (err as Error).message.slice(0, 300); }
        } catch (err) {
          throw Object.assign(err as Error, { log });
        }
        return log;
      },
    },
  };
}
