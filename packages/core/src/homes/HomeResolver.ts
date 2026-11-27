/**
 * The kernel Home Resolver (D65 §12, D67, D72, D74, D79; Phase 5 stream H).
 *
 * One function decides which directory a process sees as `/home/aura`:
 *
 *   application, sidecar   the App Home of the installation: `global`, or the
 *                          owner's `users/<userId>` for `environmentScope: user`.
 *                          Never a Private Home (D65 §8, D84).
 *   terminal-session       the session user's Private Home (D69). The
 *                          instance itself is the user's session context
 *                          (P5-4), so it needs a namespace runtime and runs
 *                          as that user (stream T); as root only while the
 *                          owner's home still awaits the ownership apply
 *                          (AppManager `ownerHomeAwaitsOwnership`).
 *   jump                   `private` (default) the jumping user's Private
 *                          Home, `app` the App Home (D79: as the app's
 *                          identity, owner or `app.jump:<installationId>`),
 *                          `ephemeral` a tmpfs. Every jump needs a runtime
 *                          that opens sessions inside the running environment
 *                          (D74); `private` and `ephemeral` also need the
 *                          per-session Private Home mapping and a non-root
 *                          target instance (J.5).
 *
 * The path rules are `planHomeTarget` (plan.ts), shared with the report mode,
 * so the report shows exactly what this resolver mounts.
 *
 * Fail closed, never a downgrade: an unresolved installation or identity, a
 * missing user, an unauthorized principal or a missing runtime capability
 * throws (`HomeDeniedError`, `RuntimeCapabilityError`); nothing falls back to
 * the shared home or to another kind of home.
 *
 * Lazy creation (D65 §6): a missing home is created on resolve, empty, owned
 * by its identity (the app identity for App Homes, the user's for Private
 * Homes), mode 0700. Its parents are root-owned 0711, so nobody lists the
 * homes of others. An existing home is never chowned here: an App Home gets
 * its app uid through the ownership rows at a `runAs: app` start (P5-3,
 * `appOwnershipSpecs`), a Private Home only through the owner-approved
 * ownership apply (P5-2, D70: never a blanket chown). A home path that is a
 * symbolic link or not a directory is refused, never followed.
 */
import { chmodSync, chownSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LinuxIdentity } from '../identity/types.js';
import { RuntimeCapabilityError, missingCapabilities, type RuntimeCapabilities, type RuntimeCapability } from '../runtimes/types.js';
import { requestNeeds } from '../runtimes/requirements.js';
import { APP_HOMES_SUBPATH, planHomeTarget } from './plan.js';
import { HOMES_ROOT_SUBPATH } from '../scopes/home.js';
import { HomeDeniedError, LOGICAL_HOME_PATH, type ExecutionContext, type HomeRequest, type HomeResolver, type JumpHomeMode, type ResolvedHome } from './types.js';

/** Mode of every home directory (D65: private by default). */
export const HOME_DIR_MODE = 0o700;
/** Mode of the root-owned directories above a home: traversable, not listable. */
export const HOME_PARENT_MODE = 0o711;

export interface KernelHomeResolverDeps {
  dataDir: string;
  /** A human user's Linux identity (D70); null when none is allocated. Never allocates under a guess. */
  userIdentity(userId: string): Promise<LinuxIdentity | null>;
  /**
   * D79: may this principal jump into the installation with `--home app`?
   * The owner always may; a member needs `app.jump:<installationId>`.
   */
  mayJumpApp(principal: { userId: string; role: 'owner' | 'member' }, installationId: string): Promise<boolean>;
  /** Tests: the chown used for a newly created home (default `fs.chownSync`). */
  chown?: (path: string, uid: number, gid: number) => void;
  /** Report mode: decide everything, create nothing (`aura admin homes plan`). */
  create?: boolean;
}

/**
 * What a home request needs, as plain data (no functions, JSON-serializable):
 * the runtime capabilities (`missingCapabilities` semantics: `isolation` is a
 * minimum level, booleans must be true) and the non-capability conditions the
 * resolver enforces. Stable export for Phase 5b's one `requirementsOf()`
 * (D85 A5): a runtime check can ask it without resolving a home.
 */
export interface HomeRequirements {
  executionContext: ExecutionContext;
  jumpHomeMode?: JumpHomeMode;
  /** Runtime capabilities the target runtime must declare. */
  capabilities: Partial<RuntimeCapabilities>;
  /** A recorded installation (App Homes). */
  installation: boolean;
  /** A verified human principal acting for itself (sessions). */
  principal: boolean;
  /** The target instance must not run as root (J.5: `private`, `ephemeral`). */
  nonRootTarget: boolean;
  /** An `app.jump` authorization unless the principal is the owner (D79). */
  jumpAuthorization: boolean;
}

export function homeRequirements(req: { executionContext: ExecutionContext; jumpHomeMode?: JumpHomeMode }): HomeRequirements {
  const ctx = req.executionContext;
  const mode = ctx === 'jump' ? req.jumpHomeMode ?? 'private' : undefined;
  // The one needs derivation (runtimes/requirements.ts, D85 A5): a Terminal instance is a user's session
  // context, a namespace boundary at least (PRoot never, D65 §11); a jump is a session inside the instance.
  const capabilities: Partial<RuntimeCapabilities> = requestNeeds(ctx, mode ? { jumpHomeMode: mode } : {});
  return {
    executionContext: ctx, ...(mode ? { jumpHomeMode: mode } : {}), capabilities,
    installation: ctx === 'application' || ctx === 'sidecar' || mode === 'app',
    principal: ctx === 'jump' || ctx === 'terminal-session',
    nonRootTarget: ctx === 'jump' && mode !== 'app',
    jumpAuthorization: mode === 'app',
  };
}

/** Runtime capabilities a request needs and its runtime lacks (fail closed on a miss). */
function neededCapabilities(req: HomeRequest): RuntimeCapability[] {
  return missingCapabilities(req.runtime, homeRequirements(req).capabilities);
}

export function kernelHomeResolver(deps: KernelHomeResolverDeps): HomeResolver {
  const chown = deps.chown ?? chownSync;
  const create = deps.create ?? true;
  return {
    async resolve(req: HomeRequest): Promise<ResolvedHome> {
      const session = req.executionContext === 'jump' || req.executionContext === 'terminal-session';
      // A session's user is its principal (planHomeTarget refuses another user's Private Home).
      const userId = session ? req.userId ?? req.principal?.userId : req.userId;
      const target = planHomeTarget(deps.dataDir, {
        installationId: req.installationId, environmentScope: req.environmentScope, executionContext: req.executionContext,
        ...(userId ? { userId } : {}),
        ...(req.jumpHomeMode ? { jumpHomeMode: req.jumpHomeMode } : {}),
        ...(req.principal ? { principal: req.principal } : {}),
        ...(req.preview ? { preview: true } : {}),
      });
      if (session && (!req.principal || req.principal.userId !== userId)) {
        throw new HomeDeniedError('not-authorized', 'a session acts for its own verified user only');
      }

      const missing = neededCapabilities(req);
      if (missing.length) {
        throw new RuntimeCapabilityError('target', missing, `this runtime can't provide the ${target.kind} home securely: missing ${missing.join(', ')} (no weaker mapping is used)`);
      }

      const app = req.appIdentity;
      if (req.executionContext === 'jump') {
        const mode = req.jumpHomeMode ?? 'private';
        if (mode === 'app') {
          const p = req.principal!;
          if (p.role !== 'owner' && !(await deps.mayJumpApp(p, req.installationId!))) {
            throw new HomeDeniedError('not-authorized', `user ${p.userId} holds no app.jump grant for this installation`);
          }
        } else if (!app || app.uid === 0 || app.gid === 0) {
          // J.5: a root app could reach the session's home through /proc/<pid>/root.
          throw new HomeDeniedError('root-instance', `a ${mode} jump needs a non-root target instance`);
        }
      }

      let owner: LinuxIdentity;
      if (target.owner?.kind === 'app') {
        if (!app) throw new HomeDeniedError('identity-unresolved', 'the installation\'s process identity is not known');
        owner = app;
      } else {
        const id = await deps.userIdentity(target.owner!.userId);
        if (!id) throw new HomeDeniedError('identity-unresolved', `user ${target.owner!.userId} has no Linux identity`);
        owner = id;
      }
      if (req.executionContext === 'terminal-session') {
        // The session's own user (stream T); root only for the owner before the ownership apply. Never an app or another user.
        if (app && app.uid !== 0 && (app.uid !== owner.uid || app.gid !== owner.gid)) {
          throw new HomeDeniedError('not-authorized', 'a Terminal session runs as its own user only');
        }
      }

      const resolved: ResolvedHome = {
        kind: target.kind, hostPath: target.hostPath, volumeSubpath: target.volumeSubpath,
        logicalPath: LOGICAL_HOME_PATH, uid: owner.uid, gid: owner.gid, mode: HOME_DIR_MODE,
      };
      if (create && resolved.hostPath) ensureHomeDir(deps.dataDir, resolved.hostPath, owner, chown);
      return resolved;
    },
  };
}

/** The roots under which this resolver creates homes, relative to the data dir. */
const HOME_ROOTS = [APP_HOMES_SUBPATH, HOMES_ROOT_SUBPATH];

/**
 * Creates a missing home (and its root-owned parents up to the homes root),
 * empty, owned by `owner`, 0700. An existing home is checked, never changed.
 */
export function ensureHomeDir(
  dataDir: string, home: string, owner: LinuxIdentity,
  chown: (path: string, uid: number, gid: number) => void = chownSync,
): void {
  const root = HOME_ROOTS.map((r) => `${dataDir.replace(/\/+$/, '')}/${r}`).find((r) => home.startsWith(`${r}/`));
  if (!root) throw new HomeDeniedError('home-unsafe', 'a home lies outside the homes roots');
  // Parents, top down: created root-owned 0711; an existing one must be a real directory.
  const parents: string[] = [];
  for (let p = dirname(home); p.length >= root.length; p = dirname(p)) {
    parents.unshift(p);
    if (p === root) break;
  }
  mkdirSync(dirname(root), { recursive: true }); // `<data>/aura`, the OS's own state dir
  for (const p of parents) {
    const st = lstatOrNull(p);
    if (st) {
      if (st.isSymbolicLink() || !st.isDirectory()) throw new HomeDeniedError('home-unsafe', 'a parent of the home is not a directory');
      continue;
    }
    mkdirQuiet(p, HOME_PARENT_MODE);
    chmodSync(p, HOME_PARENT_MODE); // the umask may have narrowed it
  }
  const st = lstatOrNull(home);
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) throw new HomeDeniedError('home-unsafe', 'the home path is a symbolic link or not a directory');
    return;
  }
  if (!mkdirQuiet(home, HOME_DIR_MODE)) {
    // Created concurrently: check what is there now, never touch it.
    const again = lstatOrNull(home);
    if (!again || again.isSymbolicLink() || !again.isDirectory()) throw new HomeDeniedError('home-unsafe', 'the home path changed while it was created');
    return;
  }
  chown(home, owner.uid, owner.gid);
  chmodSync(home, HOME_DIR_MODE);
}

function lstatOrNull(p: string) {
  try { return lstatSync(p); } catch { return null; }
}

/** mkdir without `recursive`: false when it already exists. */
function mkdirQuiet(p: string, mode: number): boolean {
  try { mkdirSync(p, { mode }); return true; } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}
