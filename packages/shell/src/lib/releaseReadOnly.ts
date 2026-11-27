/**
 * D34 (Phase 6 L): the active release is read-only in Normal Mode. The one
 * answer for every write into the AuraOS tree while AuraOS runs from a
 * release: a route that writes the tree asks `refuseReleaseWrite(path)`
 * before it writes, and a write that already failed with EROFS under a
 * release becomes the same body (`releaseReadOnlyFailure`). Direct writes
 * (a Terminal, the CLI, an app) get EROFS from the read-only mounts
 * (os/release-entry.sh, runtimes/spawn/systemTreeArgs.ts).
 *
 *   409 { error: 'release-read-only', category: 'not-grantable', message, hint, details: { mode: 'normal', release } }
 *
 * D105: the structured error body (core errors/contracts.ts); the hint names
 * the one way to change the system (D68 system patches). An EROFS outside a
 * release is not this module's: a closed install's source is `source-closed`
 * (D105 Pass B).
 */
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { runningRelease } from './systemMode.ts';

export const RELEASE_READ_ONLY = 'release-read-only';

const dataDir = (): string => process.env['AURA_DATA_DIR'] ?? '/data';

/** The D34 body. `what` names the write that was refused ("Creating com.example.app in the system scope"). */
export function releaseReadOnlyBody(what?: string): core.AuraErrorBody {
  const release = runningRelease();
  return {
    error: RELEASE_READ_ONLY,
    category: 'not-grantable',
    message: `${what ? `${what}: ` : ''}the active release${release ? ` (${release.id})` : ''} is read-only in Normal Mode.`,
    hint: 'Use `aura system patch start` to prepare a system patch, `aura system patch save` to record it and `aura system patch activate` to submit it for approval (D68).',
    docs: 'releases-and-updates',
    details: { mode: 'normal', release: release?.id ?? null },
  };
}

function respond(body: core.AuraErrorBody): Response {
  return new Response(JSON.stringify(body), {
    status: 409,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

/** Whether a shell path lies in a release tree (the running one, or any on the data volume). */
export function isReleasePath(path: string): boolean {
  try { return core.inReleaseTree(path, dataDir()); } catch { return false; }
}

/** Before a write: the 409 when `path` lies in a release, else null (go on). */
export function refuseReleaseWrite(path: string, what?: string): Response | null {
  return isReleasePath(path) ? respond(releaseReadOnlyBody(what)) : null;
}

/**
 * After a failed write: an EROFS whose path lies in a release (or any EROFS
 * while AuraOS runs from one and the error names no path) as the D34 body;
 * null for anything else.
 */
export function releaseReadOnlyFailure(err: unknown, what?: string): { status: 409; body: core.AuraErrorBody } | null {
  const e = err as NodeJS.ErrnoException | null;
  if (e?.code !== 'EROFS') return null;
  const inRelease = e.path ? isReleasePath(e.path) : runningRelease() !== null;
  return inRelease ? { status: 409, body: releaseReadOnlyBody(what) } : null;
}
