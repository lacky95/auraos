/**
 * The write gate of a release activation (Phase 6 stream U, Q35, owner
 * question g). After a release switch the kernel boots with writes held
 * (`aura/boot/writes-held`, status.json `acceptingWrites: false`): until the
 * updater's health check passes and it calls accept-writes, a mutating client
 * or App Host gateway call answers 503 `release-verifying` (apps retry), so a
 * failed release can be rolled back together with its data snapshot without
 * losing anything a user did. Passes: every read, the health probe and login
 * (`/api/auth/*`), approvals (the owner's choice after an abandoned
 * activation), the release routes (accept or roll back) and the desktop's
 * client registration. The kernel's own startup writes (migrations) and the
 * services' writes to their own data are outside the gate (covered by the
 * snapshot, or documented as outside Q35).
 *
 * The marker is the source of truth: when it is gone (the accept-writes route,
 * or the updater's fallback when the API was unreachable after a healthy
 * probe), the gate tells the kernel and opens.
 */
import { existsSync } from 'node:fs';
import * as core from '@aura/core';

export const RELEASE_VERIFYING = 'release-verifying';
const MUTATING: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PASS: readonly RegExp[] = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/approvals(\/|$)/,
  /^\/api\/admin\/release(\/|$)/,
  /^\/api\/os\/clients(\/|$)/,
];

/** Whether `method path` is held while writes are not accepted. */
export const isHeldWrite = (method: string, path: string): boolean =>
  MUTATING.has(method.toUpperCase()) && !PASS.some((re) => re.test(path));

export function releaseVerifying(): Response {
  return new Response(JSON.stringify({
    error: RELEASE_VERIFYING,
    message: 'AuraOS is verifying a new release: changes are held for a moment. Retry shortly.',
    category: 'unavailable',
    hint: 'Writes open as soon as the release is healthy (usually under a minute). If this persists, the owner checks `aura release status`.',
  }), { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '5' } });
}

/** Re-reads the marker at most this often while held. */
const RECHECK_MS = 1_000;
let lastCheck = 0;

export interface WriteGateDeps {
  system(): Pick<core.SystemHandle, 'status' | 'acceptWrites'> | null;
  markerExists(): boolean;
  now(): number;
}

const liveDeps: WriteGateDeps = {
  system: () => core.getSystem(),
  markerExists: () => existsSync(core.releasePaths.dataLayout().writesHeld),
  now: () => Date.now(),
};

/** The gate: null to go on, or the 503 to answer. */
export function writeGate(method: string, path: string, deps: WriteGateDeps = liveDeps): Response | null {
  const sys = deps.system();
  if (!sys || sys.status().acceptingWrites) return null;
  const t = deps.now();
  if (t - lastCheck >= RECHECK_MS) {
    lastCheck = t;
    if (!deps.markerExists()) {
      sys.acceptWrites();
      return null;
    }
  }
  return isHeldWrite(method, path) ? releaseVerifying() : null;
}

/** Tests: forget the last marker check. */
export const resetWriteGate = (): void => { lastCheck = 0; };
