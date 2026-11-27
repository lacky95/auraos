/**
 * Series identity (Q23, D68 "approval integrity"): per-patch sha256 and the
 * series digest an approval binds. Deterministic and independent of the YAML
 * formatting, subjects and timestamps: only the target, the base and each
 * patch's bytes and enabled flag, in order, count.
 */
import { createHash } from 'node:crypto';
import type { PatchBinding, PatchTarget } from './types.js';

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** The parts of a series its digest covers. */
export interface DigestInput {
  target: PatchTarget;
  base: { commit: string; path?: string };
  patches: Array<{ sha256: string; enabled: boolean }>;
}

/** The target as the digest sees it: an app's scope is the installation's, not the series'. */
function canonicalTarget(t: PatchTarget): Record<string, string> {
  return t.kind === 'app' ? { kind: 'app', appId: t.appId } : { kind: 'system' };
}

/** sha256 over the canonical JSON of target, base and the ordered patch list. */
export function seriesDigest(s: DigestInput): string {
  const canonical = JSON.stringify({
    target: canonicalTarget(s.target),
    base: { commit: s.base.commit, path: s.base.path ?? null },
    patches: s.patches.map((p) => [p.sha256, p.enabled === false ? 0 : 1]),
  });
  return sha256Hex(canonical);
}

/** The binding of an activation of `rev` (the caller adds the installation's scope to an app target). */
export function patchBinding(s: DigestInput, rev: string, opts: { target?: PatchTarget; composition?: string } = {}): PatchBinding {
  return {
    target: opts.target ?? s.target,
    baseCommit: s.base.commit,
    seriesRev: rev,
    seriesDigest: seriesDigest(s),
    order: s.patches.filter((p) => p.enabled !== false).map((p) => p.sha256),
    disabled: s.patches.filter((p) => p.enabled === false).map((p) => p.sha256),
    ...(opts.composition ? { composition: opts.composition } : {}),
  };
}
