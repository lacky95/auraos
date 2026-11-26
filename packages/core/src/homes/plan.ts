/**
 * The Home Resolver in `report` mode (Phase 5 stream I; D65, D67, D72, D74).
 *
 * `planHomeTarget` is the Phase 5 rule set as a pure function: which
 * directory a process WILL see as `/home/aura` once stream H switches the
 * spawn seam over. Nothing mounts it yet: `homePlan` sets it against today's
 * source (`legacyHomeResolver`, the one shared home) per running instance,
 * for `GET /api/admin/homes/plan` and `diagnose/homes` in report form.
 *
 *   application, sidecar   the App Home: `apphomes/<installationId>/global`, or
 *                          `…/users/<userId>` for `environmentScope: user`;
 *                          never a Private Home (D84: human users only)
 *   terminal-session       the session user's Private Home
 *   jump                   `private` (default) the jumping user's Private Home,
 *                          `app` the App Home, `ephemeral` a tmpfs
 *
 * Fail closed, never a downgrade: an unresolved installation, a missing user
 * or a principal where none belongs is a `HomeDeniedError`. Runtime
 * capability checks stay with stream H's resolver.
 */
import { join } from 'node:path';
import { homeDirFor, homeSubpathFor } from '../scopes/home.js';
import { HomeDeniedError, type EnvironmentScope, type ExecutionContext, type HomeKind, type JumpHomeMode } from './types.js';

/** App Homes, as a subpath inside the app-data volume (D65). */
export const APP_HOMES_SUBPATH = 'aura/apphomes';

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function appHomeSubpath(installationId: string, scope: EnvironmentScope, userId?: string): string {
  if (!SEGMENT.test(installationId)) throw new HomeDeniedError('installation-unresolved', 'invalid installation id');
  if (scope === 'global') return `${APP_HOMES_SUBPATH}/${installationId}/global`;
  if (!userId || !SEGMENT.test(userId)) throw new HomeDeniedError('user-required', 'a per-user App Home needs its user');
  return `${APP_HOMES_SUBPATH}/${installationId}/users/${userId}`;
}

export interface HomeTargetRequest {
  installationId: string | null;
  environmentScope: EnvironmentScope;
  executionContext: ExecutionContext;
  /** The instance's owner (application, sidecar) or the session's user (terminal-session, jump). */
  userId?: string;
  jumpHomeMode?: JumpHomeMode;
  /** Only `jump` and `terminal-session` carry one (D84: no Private Home without a human user). */
  principal?: { userId: string; role: 'owner' | 'member' };
}

/** Where `/home/aura` will come from, and whose identity owns it. */
export interface HomeTarget {
  kind: HomeKind;
  /** Shell view; null for `ephemeral`. */
  hostPath: string | null;
  volumeSubpath: string | null;
  /** The identity that will own the directory. */
  owner: { kind: 'app'; installationId: string } | { kind: 'user'; userId: string } | null;
}

export function planHomeTarget(dataDir: string, req: HomeTargetRequest): HomeTarget {
  const appHome = (): HomeTarget => {
    if (!req.installationId) throw new HomeDeniedError('installation-unresolved', 'the installation is not known');
    const sub = appHomeSubpath(req.installationId, req.environmentScope, req.userId);
    return {
      kind: req.environmentScope === 'global' ? 'app-global' : 'app-user',
      hostPath: join(dataDir, ...sub.split('/')), volumeSubpath: sub,
      owner: { kind: 'app', installationId: req.installationId },
    };
  };
  const privateHome = (): HomeTarget => {
    const p = req.principal;
    if (!p) throw new HomeDeniedError('user-required', 'a Private Home needs the verified user');
    if (req.userId !== undefined && req.userId !== p.userId) throw new HomeDeniedError('not-authorized', 'a Private Home is its own user\'s only');
    return { kind: 'private', hostPath: homeDirFor(dataDir, p.userId), volumeSubpath: homeSubpathFor(p.userId), owner: { kind: 'user', userId: p.userId } };
  };
  switch (req.executionContext) {
    case 'application':
    case 'sidecar':
      if (req.principal) throw new HomeDeniedError('private-home-not-allowed', 'an app process never carries a user principal for its home');
      return appHome();
    case 'terminal-session':
      return privateHome();
    case 'jump':
      switch (req.jumpHomeMode ?? 'private') {
        case 'private': return privateHome();
        case 'app': return appHome();
        case 'ephemeral':
          if (!req.principal) throw new HomeDeniedError('user-required', 'a jump needs the verified user');
          return { kind: 'ephemeral', hostPath: null, volumeSubpath: null, owner: { kind: 'user', userId: req.principal.userId } };
      }
  }
  throw new HomeDeniedError('not-authorized', 'unknown execution context');
}

/** Apps whose instances are a user's terminal sessions (D69): their home is the owner's Private Home. */
export const TERMINAL_SESSION_APPS: ReadonlySet<string> = new Set(['com.aura.terminal']);

export interface HomePlanInstance {
  instanceId: string;
  appId: string;
  installationId: string | null;
  environmentScope: EnvironmentScope;
  /** The instance's server-side owner. */
  owner?: string;
  /** Today's `/home/aura` source (the legacy resolver's `hostPath`). */
  currentHostPath: string;
}

export interface HomePlanRow {
  instanceId: string;
  appId: string;
  installationId: string | null;
  executionContext: ExecutionContext;
  current: string;
  target: HomeTarget | null;
  /** `same`, `moves` (H will mount another directory) or `denied` (fails closed under H). */
  change: 'same' | 'moves' | 'denied';
  denied?: string;
}

export interface HomePlanReport {
  version: 1;
  generatedAt: string;
  mode: 'report';
  rows: HomePlanRow[];
  summary: { same: number; moves: number; denied: number };
}

/** Today's source against the Phase 5 target, per instance. Reads nothing on disk. */
export function homePlan(dataDir: string, instances: readonly HomePlanInstance[], opts: { now?: () => number } = {}): HomePlanReport {
  const rows: HomePlanRow[] = [];
  for (const inst of [...instances].sort((a, b) => a.appId.localeCompare(b.appId) || a.instanceId.localeCompare(b.instanceId))) {
    const terminal = TERMINAL_SESSION_APPS.has(inst.appId);
    const executionContext: ExecutionContext = terminal ? 'terminal-session' : 'application';
    const base = { instanceId: inst.instanceId, appId: inst.appId, installationId: inst.installationId, executionContext, current: inst.currentHostPath };
    try {
      const target = planHomeTarget(dataDir, {
        installationId: inst.installationId, environmentScope: inst.environmentScope, executionContext,
        ...(inst.owner ? { userId: inst.owner } : {}),
        // The Terminal's session user is its owner (D69); the role does not choose the home.
        ...(terminal && inst.owner ? { principal: { userId: inst.owner, role: 'member' as const } } : {}),
      });
      rows.push({ ...base, target, change: target.hostPath === inst.currentHostPath ? 'same' : 'moves' });
    } catch (err) {
      if (!(err instanceof HomeDeniedError)) throw err;
      rows.push({ ...base, target: null, change: 'denied', denied: err.reason });
    }
  }
  const count = (c: HomePlanRow['change']) => rows.filter((r) => r.change === c).length;
  return {
    version: 1, generatedAt: new Date((opts.now ?? Date.now)()).toISOString(), mode: 'report', rows,
    summary: { same: count('same'), moves: count('moves'), denied: count('denied') },
  };
}
