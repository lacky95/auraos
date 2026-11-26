/**
 * Privileged work in the master (SF-1, SF-2): the one way an owner route runs
 * a program as root here, and the one gate in front of it.
 *
 *   - argv only: `runArgv` is spawnSync with an argv array, never a shell;
 *     every argument comes from validated data (core capabilities/definition.ts:
 *     Debian names, npm names, https URLs, normalized paths);
 *   - apt always verifies signatures (`APT_VERIFY_ARGS`, whatever the target's
 *     apt.conf.d says) and takes package names after `--`; there is no
 *     insecure fallback;
 *   - `privilegedAction`: the owner decides (lib/approvals/admin.ts
 *     `ownerAction`), and the approval binds `{ operation, ...bind }`, so it
 *     covers exactly that operation on exactly that data, once;
 *   - `auditPrivileged`: every run is audited with the approver (`actor.by`),
 *     the requester and approval (`actor.detail`), what ran and the result.
 */
import { spawnSync } from 'node:child_process';
import { auditOwner, ownerAction, type OwnerActor } from './approvals/admin.ts';
import type { ApprovalLevel } from '@aura/core';

export { DEBIAN_PACKAGE_RE, isDebianPackageName } from '@aura/core';

type Ctx = Parameters<typeof ownerAction>[0];

/** One program, by argv (no shell). Returns its output; throws with it when it fails. */
export type RunCommand = (file: string, args: readonly string[], opts: { timeoutMs: number; cwd?: string }) => string;

export interface PrivilegedDeps {
  ownerAction(ctx: Ctx, req: Parameters<typeof ownerAction>[1]): Promise<OwnerActor | Response>;
  audit(actor: OwnerActor, action: string, opts: Parameters<typeof auditOwner>[2]): Promise<void>;
  run: RunCommand;
}

export const runArgv: RunCommand = (file, args, { timeoutMs, cwd }) => {
  const r = spawnSync(file, [...args], {
    encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}),
    env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.error) throw new Error(`${file} ${args.join(' ')}: ${r.error.message}${out ? `\n${out}` : ''}`);
  if (r.status !== 0) throw new Error(`${file} ${args.join(' ')} exited ${r.status ?? r.signal}${out ? `\n${out}` : ''}`);
  return out;
};

export function livePrivilegedDeps(): PrivilegedDeps {
  return {
    ownerAction: (ctx, req) => ownerAction(ctx, req),
    audit: (actor, action, opts) => auditOwner(actor, action, opts),
    run: runArgv,
  };
}

/**
 * apt options that keep signature verification on whatever the target's own
 * apt.conf.d says: no unsigned repository or package gets through, and there
 * is no switch to allow one.
 */
export const APT_VERIFY_ARGS: readonly string[] = [
  '-o', 'Acquire::AllowInsecureRepositories=false',
  '-o', 'Acquire::AllowDowngradeToInsecureRepositories=false',
  '-o', 'APT::Get::AllowUnauthenticated=false',
];

/** `apt-get update` and `apt-get install -- <packages>` (or a checked local .deb path), verified. */
export const aptUpdateArgv = (): string[] => ['apt-get', ...APT_VERIFY_ARGS, 'update', '-qq'];
export const aptInstallArgv = (packages: readonly string[], opts: { recommends?: boolean } = {}): string[] =>
  ['apt-get', ...APT_VERIFY_ARGS, 'install', '-y', '-q', ...(opts.recommends ? [] : ['--no-install-recommends']), '--', ...packages];

/** apt's words for a signature it could not verify. */
export const UNVERIFIED_RE = /NO_PUBKEY|not signed|signature|cannot be authenticated|unauthenticated|is not valid yet|EXPKEYSIG/i;
export const UNVERIFIED_HINT = 'apt could not verify a repository or package signature. AuraOS never installs unverified packages: fix the keyring or sources and try again.';

export interface PrivilegedRequest {
  /** The audit action and the approval's operation, e.g. `base-rootfs.install`. */
  operation: string;
  /** What the approval binds besides the operation: the validated, normalized data that will run. */
  bind: Record<string, unknown>;
  level: ApprovalLevel;
  title: string;
  details: readonly string[];
}

/** The owner's decision on one privileged operation, bound to `{ operation, ...bind }`. */
export function privilegedAction(deps: PrivilegedDeps, ctx: Ctx, req: PrivilegedRequest): Promise<OwnerActor | Response> {
  return deps.ownerAction(ctx, {
    action: 'admin.change', payload: { operation: req.operation, ...req.bind }, level: req.level,
    title: req.title, details: [...req.details],
  });
}

/** Audit one privileged run: approver and requester come with the actor, the rest with `detail`. */
export function auditPrivileged(
  deps: PrivilegedDeps, actor: OwnerActor, operation: string,
  opts: { target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown>; error?: string },
): Promise<void> {
  return deps.audit(actor, operation, {
    target: opts.target, outcome: opts.outcome,
    detail: { operation, ...opts.detail, ...(opts.error ? { error: opts.error.slice(0, 300) } : {}) },
  });
}
