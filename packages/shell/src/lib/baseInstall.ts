/**
 * `POST /api/admin/base-install`: installs the base-rootfs essentials every
 * PRoot ships with into a RUNNING master's `/os/base-rootfs`.
 *
 * The Dockerfile's base-rootfs stage already installs these at image build,
 * but that needs `docker compose up --build`. This applies the same set to
 * the running container's base-rootfs, so the canonical list can change
 * without a rebuild. Idempotent: apt-get skips packages already present.
 *
 * Mechanism: chroot into the base-rootfs and run apt-get there. The
 * base-rootfs is a complete Debian filesystem with its own apt config and the
 * Debian archive keyring, so apt verifies every signature as usual: the
 * route never turns that off, and a failed verification fails the request
 * (D94 G8). resolv.conf is copied in first so DNS works inside the chroot,
 * and `<rootfs>/dev/{null,zero,random,urandom}` are made the right character
 * devices (lib/chrootDevices.ts: mknod by argv, symlinks refused, a wrong
 * node replaced atomically): apt cannot verify without `/dev/null`.
 *
 * It runs as root in the master (D8/D30), so (SF-1, through the shared
 * privileged-exec gate lib/privilegedExec.ts):
 *   - the body may only name packages: each one a Debian package name (no
 *     option, version, release, path, URL or `.deb`), run as an argv
 *     element of `chroot … apt-get … --`, never through a shell; it cannot
 *     add a source or an apt option;
 *   - it is an owner action (D50, lib/approvals/admin.ts `ownerAction`):
 *     the built-in list (this module's constant, compared after
 *     normalization) one click (`session`), any other list the password
 *     (`fresh`); the approval binds the operation and the normalized list;
 *     the owner in the desktop and the host operator act directly;
 *   - each run is audited: requester, approver, list and result.
 *
 * Body: `{}` or `{ packages?: string[] }` (empty or absent: the built-in list).
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ApprovalLevel } from '@aura/core';
import { json } from './approvals/service.ts';
import { ensureChrootDevices } from './chrootDevices.ts';
import {
  aptInstallArgv, aptUpdateArgv, auditPrivileged, isDebianPackageName, livePrivilegedDeps, privilegedAction, runArgv,
  UNVERIFIED_HINT, UNVERIFIED_RE, type PrivilegedDeps,
} from './privilegedExec.ts';

export { APT_VERIFY_ARGS } from './privilegedExec.ts';

/** The built-in list (the Dockerfile's base-rootfs stage installs the same at build). */
export const BASE_ESSENTIALS: readonly string[] = [
  'openssh-client',
  'openssh-server',
  'nano',
  'less',
  'htop',
  'lsof',
  'dnsutils',
  'iproute2',
];

export const MAX_PACKAGES = 64;
export const BASE_INSTALL_AUDIT_ACTION = 'base-rootfs.install';

type Ctx = Parameters<PrivilegedDeps['ownerAction']>[0];

export interface BaseInstallDeps extends PrivilegedDeps {
  /** Stages the master's resolv.conf into the chroot; returns whether it did. */
  stageResolvConf(baseRootfs: string): boolean;
  /** Makes `<rootfs>/dev/{null,zero,random,urandom}` the right devices (fails closed); returns what it changed. */
  ensureDevices(baseRootfs: string): string[];
  exists(path: string): boolean;
  baseRootfs: string;
}

export function liveBaseInstallDeps(): BaseInstallDeps {
  return {
    ...livePrivilegedDeps(),
    stageResolvConf: (baseRootfs) => {
      if (!existsSync('/etc/resolv.conf')) return false;
      const dst = join(baseRootfs, 'etc', 'resolv.conf');
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync('/etc/resolv.conf', dst);
      return true;
    },
    ensureDevices: (baseRootfs) => ensureChrootDevices(baseRootfs, runArgv),
    exists: existsSync,
    baseRootfs: process.env['AURA_BASE_ROOTFS'] ?? '/os/base-rootfs',
  };
}

/** The one key a body may carry. Anything else (a "default" flag, sources, options) is refused. */
const BODY_KEYS = new Set(['packages']);

/**
 * The validated, normalized package list a body asks for (deduplicated and
 * sorted: what the owner approves and what runs), or why it is refused.
 * Every name is a Debian package name and nothing else (core
 * `isDebianPackageName`): no option, version, release, architecture, path,
 * URL, `.deb` or remove modifier. The body cannot add a source or an option.
 */
export function parsePackages(body: unknown): { packages: string[] } | { error: string } {
  const builtIn = { packages: normalize(BASE_ESSENTIALS) };
  if (body === undefined || body === null) return builtIn;
  if (typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object: { packages?: string[] }' };
  const extra = Object.keys(body).filter((k) => !BODY_KEYS.has(k));
  if (extra.length) return { error: `unknown field: ${extra.slice(0, 5).join(', ')} (only \`packages\`)` };
  const raw = (body as { packages?: unknown }).packages;
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return builtIn;
  if (!Array.isArray(raw)) return { error: '`packages` must be an array of Debian package names' };
  if (raw.length > MAX_PACKAGES) return { error: `at most ${MAX_PACKAGES} packages` };
  const bad = raw.filter((p) => !isDebianPackageName(p));
  if (bad.length) return { error: `not a Debian package name: ${bad.slice(0, 5).map((p) => JSON.stringify(p)).join(', ')}` };
  return { packages: normalize(raw as string[]) };
}

const normalize = (list: readonly string[]): string[] => [...new Set(list)].sort();
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((p, i) => p === b[i]);

/** The built-in list (the server's constant, after normalization) is one click; any other list, the password. */
export function baseInstallLevel(packages: readonly string[]): ApprovalLevel {
  return sameList(normalize(packages), normalize(BASE_ESSENTIALS)) ? 'session' : 'fresh';
}

export async function postBaseInstall(ctx: Ctx, deps: BaseInstallDeps = liveBaseInstallDeps()): Promise<Response> {
  let body: unknown;
  const text = await ctx.request.text();
  if (text.trim() !== '') {
    try { body = JSON.parse(text); } catch { return json({ error: 'invalid-request', message: 'body must be JSON: { packages?: string[] }' }, 400); }
  }
  const parsed = parsePackages(body);
  if ('error' in parsed) return json({ error: 'invalid-request', message: parsed.error }, 400);
  const { packages } = parsed;

  const { baseRootfs } = deps;
  if (!deps.exists(baseRootfs)) return json({ error: `base-rootfs not found: ${baseRootfs}` }, 500);

  // The approval binds its payload's hash: this operation on exactly this
  // normalized list. Another list, or another operation, needs a new one.
  const level = baseInstallLevel(packages);
  const actor = await privilegedAction(deps, ctx, {
    operation: BASE_INSTALL_AUDIT_ACTION, bind: { packages }, level,
    title: level === 'session' ? 'Install the built-in packages into the PRoot base system' : 'Install packages into the PRoot base system',
    details: [
      `Packages: ${packages.join(', ')}`,
      'Installed as root with apt (signatures verified) into the base system every PRoot app starts from.',
    ],
  });
  if (actor instanceof Response) return actor;

  const log: string[] = [];
  const target = `rootfs:${baseRootfs}`;
  try {
    if (deps.stageResolvConf(baseRootfs)) log.push('staged /etc/resolv.conf for chroot DNS');
    log.push(...deps.ensureDevices(baseRootfs));
    log.push(deps.run('chroot', [baseRootfs, ...aptUpdateArgv()], { timeoutMs: 60_000 }));
    log.push(deps.run('chroot', [baseRootfs, ...aptInstallArgv(packages)], { timeoutMs: 300_000 }));
  } catch (err) {
    const message = (err as Error).message;
    await auditPrivileged(deps, actor, BASE_INSTALL_AUDIT_ACTION, { target, outcome: 'failed', detail: { packages, level }, error: message });
    return json({ error: message, log, ...(UNVERIFIED_RE.test(message) ? { hint: UNVERIFIED_HINT } : {}) }, 500);
  }
  await auditPrivileged(deps, actor, BASE_INSTALL_AUDIT_ACTION, { target, outcome: 'ok', detail: { packages, level } });
  return json({ ok: true, baseRootfs, packages, log });
}
