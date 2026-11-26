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
 * (D94 G8). resolv.conf is copied in first so DNS works inside the chroot.
 *
 * It runs as root in the master (D8/D30), so (SF-1):
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
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ApprovalLevel } from '@aura/core';
import { auditOwner, ownerAction, type OwnerActor } from './approvals/admin.ts';
import { json } from './approvals/service.ts';

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

/**
 * A Debian package name (Debian Policy 5.6.7): lowercase letters, digits,
 * `+`, `-` and `.`, at least two characters, starting alphanumeric. No
 * version, architecture or path: never an option, never a shell word.
 */
export const DEBIAN_PACKAGE_RE = /^[a-z0-9][a-z0-9+.-]{1,63}$/;
export const MAX_PACKAGES = 64;

export const BASE_INSTALL_AUDIT_ACTION = 'base-rootfs.install';

type Ctx = Parameters<typeof ownerAction>[0];

/** One command, by argv (no shell). Throws with its output when it fails. */
export type RunCommand = (file: string, args: readonly string[], opts: { timeoutMs: number }) => string;

export interface BaseInstallDeps {
  ownerAction(ctx: Ctx, req: Parameters<typeof ownerAction>[1]): Promise<OwnerActor | Response>;
  audit(actor: OwnerActor, action: string, opts: Parameters<typeof auditOwner>[2]): Promise<void>;
  run: RunCommand;
  /** Stages the master's resolv.conf into the chroot; returns whether it did. */
  stageResolvConf(baseRootfs: string): boolean;
  exists(path: string): boolean;
  baseRootfs: string;
}

const runArgv: RunCommand = (file, args, { timeoutMs }) => {
  const r = spawnSync(file, [...args], {
    encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.error) throw new Error(`${file} ${args.join(' ')}: ${r.error.message}${out ? `\n${out}` : ''}`);
  if (r.status !== 0) throw new Error(`${file} ${args.join(' ')} exited ${r.status ?? r.signal}${out ? `\n${out}` : ''}`);
  return out;
};

export function liveBaseInstallDeps(): BaseInstallDeps {
  return {
    ownerAction: (ctx, req) => ownerAction(ctx, req),
    audit: (actor, action, opts) => auditOwner(actor, action, opts),
    run: runArgv,
    stageResolvConf: (baseRootfs) => {
      if (!existsSync('/etc/resolv.conf')) return false;
      const dst = join(baseRootfs, 'etc', 'resolv.conf');
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync('/etc/resolv.conf', dst);
      return true;
    },
    exists: existsSync,
    baseRootfs: process.env['AURA_BASE_ROOTFS'] ?? '/os/base-rootfs',
  };
}

/** Archive and source-file suffixes: a name apt could open as a local file, never a package from the archive. */
const FILE_SUFFIX_RE = /\.(deb|udeb|ddeb|dsc|changes|buildinfo)$/;

/**
 * apt options that keep signature verification on whatever the base-rootfs's
 * own apt.conf.d says: the route never lets an unsigned repository or package
 * through, and has no switch to.
 */
export const APT_VERIFY_ARGS: readonly string[] = [
  '-o', 'Acquire::AllowInsecureRepositories=false',
  '-o', 'Acquire::AllowDowngradeToInsecureRepositories=false',
  '-o', 'APT::Get::AllowUnauthenticated=false',
];

/** The one key a body may carry. Anything else (a "default" flag, sources, options) is refused. */
const BODY_KEYS = new Set(['packages']);

/**
 * The validated, normalized package list a body asks for (deduplicated and
 * sorted: what the owner approves and what runs), or why it is refused.
 * Every name is a Debian package name and nothing else: no option (`-x`,
 * `--x=y`), no version (`=`), release (`/`) or architecture (`:`), no path,
 * URL or `.deb`, no remove modifier (trailing `-`). The body cannot add a
 * source or an option.
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
  const bad = raw.filter((p) => !isPackageName(p));
  if (bad.length) return { error: `not a Debian package name: ${bad.slice(0, 5).map((p) => JSON.stringify(p)).join(', ')}` };
  return { packages: normalize(raw as string[]) };
}

export const isPackageName = (p: unknown): p is string =>
  typeof p === 'string' && DEBIAN_PACKAGE_RE.test(p) && !p.endsWith('-') && !FILE_SUFFIX_RE.test(p);

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
  const actor = await deps.ownerAction(ctx, {
    action: 'admin.change', payload: { operation: BASE_INSTALL_AUDIT_ACTION, packages }, level,
    title: level === 'session' ? 'Install the built-in packages into the PRoot base system' : 'Install packages into the PRoot base system',
    details: [
      `Packages: ${packages.join(', ')}`,
      'Installed as root with apt (signatures verified) into the base system every PRoot app starts from.',
    ],
  });
  if (actor instanceof Response) return actor;

  const log: string[] = [];
  const detail = { operation: BASE_INSTALL_AUDIT_ACTION, packages, level };
  try {
    if (deps.stageResolvConf(baseRootfs)) log.push('staged /etc/resolv.conf for chroot DNS');
    log.push(deps.run('chroot', [baseRootfs, 'apt-get', ...APT_VERIFY_ARGS, 'update', '-qq'], { timeoutMs: 60_000 }));
    log.push(deps.run('chroot', [
      baseRootfs, 'apt-get', ...APT_VERIFY_ARGS, 'install', '-y', '-q', '--no-install-recommends', '--', ...packages,
    ], { timeoutMs: 300_000 }));
  } catch (err) {
    const message = (err as Error).message;
    await deps.audit(actor, BASE_INSTALL_AUDIT_ACTION, { target: `rootfs:${baseRootfs}`, outcome: 'failed', detail: { ...detail, error: message.slice(0, 300) } });
    const unverified = /NO_PUBKEY|not signed|signature|cannot be authenticated|unauthenticated|is not valid yet|EXPKEYSIG/i.test(message);
    return json({
      error: message, log,
      ...(unverified ? { hint: 'apt could not verify a repository or package signature. AuraOS never installs unverified packages: fix the base-rootfs keyring or sources and try again.' } : {}),
    }, 500);
  }
  await deps.audit(actor, BASE_INSTALL_AUDIT_ACTION, { target: `rootfs:${baseRootfs}`, outcome: 'ok', detail });
  return json({ ok: true, baseRootfs, packages, log });
}
