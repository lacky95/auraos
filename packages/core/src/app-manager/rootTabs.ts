/**
 * `aura root` (Phase 5 stream J.6, P5-4, D55): the grants behind a root tab.
 *
 * The owner asks from their own System Terminal (`POST /api/admin/root`), and
 * approves with the password or the host operator (`fresh`). The shell then
 * issues ONE grant here: single use, bound to the user and the Terminal
 * instance, valid for two minutes, never persisted. Opening the root session
 * (the exec bridge, `{op:'open', root:<grant>}`) consumes it; the session is
 * a broker session into that same instance as uid 0 with Docker's default
 * capabilities, the user's Private Home and the Docker socket in the
 * session's own mount namespace only. Nothing outlives the session: a
 * Terminal or kernel restart ends it, and a new one needs a new approval.
 */
import { randomBytes } from 'node:crypto';

export const ROOT_AUDIT_ACTIONS = { granted: 'root.granted', ended: 'root.ended', refused: 'root.refused' } as const;
/** The D64 switch (security/options.ts): `disabled` refuses `aura root` (Zero Trust). */
export const AURA_ROOT_OPTION = 'aura-root';
const GRANT_TTL_MS = 2 * 60_000;
const GRANT_RE = /^[A-Za-z0-9_-]{32,64}$/;

interface RootGrant { userId: string; instanceId: string; expiresAt: number }

export class RootGrants {
  private readonly grants = new Map<string, RootGrant>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A fresh single-use grant for this user's root tab in this instance. */
  issue(userId: string, instanceId: string): { grant: string; expiresAt: number } {
    this.prune();
    const grant = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + GRANT_TTL_MS;
    this.grants.set(grant, { userId, instanceId, expiresAt });
    return { grant, expiresAt };
  }

  /** True once, for the user and instance it was issued for, before it expires. */
  consume(grant: unknown, userId: string, instanceId: string): boolean {
    if (typeof grant !== 'string' || !GRANT_RE.test(grant)) return false;
    const g = this.grants.get(grant);
    this.grants.delete(grant);
    return !!g && g.userId === userId && g.instanceId === instanceId && g.expiresAt > this.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [k, g] of this.grants) if (g.expiresAt <= now) this.grants.delete(k);
  }
}

/** A grant token's shape (the open frame's `root`), checked before anything else. */
export function isRootGrantToken(v: unknown): v is string {
  return typeof v === 'string' && GRANT_RE.test(v);
}
