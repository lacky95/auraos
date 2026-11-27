/**
 * The process identity of an app container (Phase 5 stream A, P5-3).
 *
 * `root` (today, and every installation recorded before 5-apps): nothing is
 * added, the container runs as the image's root with Docker's default set.
 * That is the legacy migration state; an APPROVED root request
 * (identity/execution.ts) runs as uid 0 with the flags below and no passwd.
 *
 * Any other identity (`runAs: app`, the installation's app uid from the
 * identity registry):
 *   --user <uid>:<gid>                    never root; no `--group-add`
 *   --cap-drop ALL                        no capability at all (D89's NET_RAW drop stays)
 *   --security-opt no-new-privileges      setuid binaries of the image (su, mount, passwd) gain nothing
 *   /etc/passwd, /etc/group read-only     rendered per instance (`app-<id>`, `pw_dir=/home/aura`), so
 *                                         git, ssh and `id` know the account
 *   AURA_RUN_AS=app                       for the start shell's messages only; it decides by `id -u`
 *   ASTRO_TELEMETRY_DISABLED=1            no telemetry state in the App Home, and no first-run prompt
 *
 * A user's session identity (stream T, D69; T2): the System Terminal instance
 * of user U hosts U's sessions as U's uid/gid (range `owner` or `user`), while
 * its server runs as the non-login service uid (`aura-terminal`,
 * TERMINAL_SERVICE_UID). The container starts as uid 0 with only SETUID and
 * SETGID (`--cap-drop ALL --cap-add SETUID --cap-add SETGID`,
 * no-new-privileges) for its session launcher (os/term-launch, sessionArgs.ts),
 * which drops to those two uids and nothing else; every other process has no
 * capability. Its passwd names U by username (`pw_dir=/home/aura`) and the
 * service account (`/nonexistent`, nologin); `AURA_RUN_AS=user`.
 *
 * There is no fallback: the runner never retries a failed non-root start as
 * root (P5-3). Sidecars keep their image user, except an `aura-base` sidecar
 * that inherits the app's home: it is the app's own code and runs as the app
 * (`sidecarIdentityArgs`).
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpawnIdentity } from '../../identity/types.js';
import { appAccountName, renderGroup, renderPasswd } from '../../identity/passwd.js';
import { TERMINAL_SERVICE_ACCOUNT, TERMINAL_SERVICE_GID, TERMINAL_SERVICE_UID } from '../../identity/types.js';

/** Where an instance's rendered identity files live, relative to the root dataDir. */
export function identityFilesSubpath(instanceId: string): string {
  return `aura/runtime/${instanceId}/identity`;
}

/** True for every identity that is not today's root. */
export function isNonRootIdentity(identity: SpawnIdentity | undefined | null): identity is SpawnIdentity {
  return !!identity && identity.range !== 'root' && identity.uid !== 0;
}

/**
 * The base accounts of an app container's passwd and group. Not read from the
 * image: the file is the same for every app and deterministic. `node` (1000)
 * stays so files of the image's `node` user keep their name.
 */
export const BASE_PASSWD = [
  'root:x:0:0:root:/root:/bin/bash',
  'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
  'bin:x:2:2:bin:/bin:/usr/sbin/nologin',
  'sys:x:3:3:sys:/dev:/usr/sbin/nologin',
  'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
  'node:x:1000:1000::/home/node:/bin/bash',
].join('\n');
export const BASE_GROUP = [
  'root:x:0:', 'daemon:x:1:', 'bin:x:2:', 'sys:x:3:', 'nogroup:x:65534:', 'node:x:1000:',
].join('\n');

/** Names the base files keep for themselves: a user account never takes one over. */
const BASE_NAMES = new Set(BASE_PASSWD.split('\n').map((l) => l.split(':')[0]!));
const ACCOUNT_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

/** True for a user's session identity (stream T): the owner's or a member's uid, never an app's. */
export function isSessionIdentity(identity: SpawnIdentity | undefined | null): boolean {
  return isNonRootIdentity(identity) && (identity.range === 'owner' || identity.range === 'user');
}

/**
 * A session HOST identity (stream T2, the System Terminal): a user identity
 * whose container starts the launcher. A D107-a `userApp` (an app process
 * running as its user) is a user identity but no session host: the plain
 * identity flags, no service account.
 */
export function isSessionHostIdentity(identity: SpawnIdentity | undefined | null): boolean {
  return isSessionIdentity(identity) && identity!.userApp !== true;
}

/**
 * The account name of a spawn identity: `app-<installation>` for an app
 * identity; a session identity's username (D69), unless it is not a safe
 * account name or one the base files use (`user-<uid>` then).
 */
export function identityAccountName(identity: SpawnIdentity, installationId: string | null): string {
  if (identity.range === 'app' && installationId) return appAccountName(installationId);
  if (isSessionIdentity(identity)) {
    const name = (identity.account ?? '').toLowerCase();
    return ACCOUNT_RE.test(name) && !BASE_NAMES.has(name) && name !== TERMINAL_SERVICE_ACCOUNT ? name : `user-${identity.uid}`;
  }
  return `aura-${identity.range}-${identity.uid}`;
}

/** The rendered `/etc/passwd` and `/etc/group` of a non-root app container. Pure. */
export function renderIdentityFiles(identity: SpawnIdentity, installationId: string | null): { passwd: string; group: string } {
  const name = identityAccountName(identity, installationId);
  const session = isSessionIdentity(identity);
  const gecos = session ? 'AuraOS user' : 'AuraOS app';
  // A session host's server runs as the Terminal service account (stream T2).
  const service = isSessionHostIdentity(identity) ? [{ name: TERMINAL_SERVICE_ACCOUNT, uid: TERMINAL_SERVICE_UID, gid: TERMINAL_SERVICE_GID, gecos: 'AuraOS Terminal server', home: '/nonexistent', shell: '/usr/sbin/nologin' }] : [];
  return {
    passwd: renderPasswd(BASE_PASSWD, [{ name, uid: identity.uid, gid: identity.gid, gecos }, ...service]),
    group: renderGroup(BASE_GROUP, [{ name, gid: identity.gid }, ...service.map((x) => ({ name: x.name, gid: x.gid }))]),
  };
}

/**
 * Writes the identity files under `<dataDir>/aura/runtime/<instanceId>/identity`
 * (root-owned, 0644 in a 0755 dir; mounted read-only). Atomic per file.
 */
export function writeIdentityFiles(dataDir: string, instanceId: string, identity: SpawnIdentity, installationId: string | null): string {
  const dir = join(dataDir, identityFilesSubpath(instanceId));
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  const files = renderIdentityFiles(identity, installationId);
  for (const [name, body] of Object.entries(files)) {
    const tmp = join(dir, `.${name}.tmp`);
    writeFileSync(tmp, body, { mode: 0o644 });
    chmodSync(tmp, 0o644);
    renameSync(tmp, join(dir, name));
  }
  return dir;
}

/** The identity flags alone: user, no capabilities, no privilege gain. */
function processIdentityFlags(identity: SpawnIdentity): string[] {
  return [
    '--user', `${identity.uid}:${identity.gid}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
  ];
}

/**
 * A session host (stream T2): uid 0 with SETUID and SETGID only, for its
 * session launcher, which starts the server as the service uid and the
 * sessions as the user's uid; no-new-privileges, so no exec gains anything.
 */
function sessionHostFlags(): string[] {
  return [
    '--user', '0:0',
    '--cap-drop', 'ALL',
    '--cap-add', 'SETUID',
    '--cap-add', 'SETGID',
    '--security-opt', 'no-new-privileges',
  ];
}

/** The passwd and group mounts of an instance's identity files. */
function identityFileMounts(appDataVolume: string, instanceId: string): string[] {
  const sub = identityFilesSubpath(instanceId);
  return [
    '--mount', `type=volume,source=${appDataVolume},target=/etc/passwd,volume-subpath=${sub}/passwd,readonly`,
    '--mount', `type=volume,source=${appDataVolume},target=/etc/group,volume-subpath=${sub}/group,readonly`,
  ];
}

export interface ContainerIdentityOpts {
  appDataVolume: string;
  instanceId: string;
}

/**
 * An approved root request (identity/execution.ts): uid 0 and nothing more.
 * Runtime root never implies privileged mode, a capability, a device, the
 * Docker socket or host access, so it gets the same no-capability flags as an
 * app identity; the image's own passwd names root.
 */
export function isApprovedRootIdentity(identity: SpawnIdentity | undefined | null): boolean {
  return !!identity && identity.approvedRoot === true && identity.uid === 0;
}

/** The `docker run` flags of an app container's identity; empty for legacy root (5-apps migration). */
export function containerIdentityArgs(identity: SpawnIdentity | undefined, opts?: ContainerIdentityOpts): string[] {
  if (isApprovedRootIdentity(identity)) return [...processIdentityFlags(identity!), '-e', 'AURA_RUN_AS=root'];
  if (!isNonRootIdentity(identity)) return [];
  if (!opts) throw new Error('a non-root app identity needs its identity files');
  return [
    ...(isSessionHostIdentity(identity) ? sessionHostFlags() : processIdentityFlags(identity)),
    ...identityFileMounts(opts.appDataVolume, opts.instanceId),
    '-e', `AURA_RUN_AS=${isSessionIdentity(identity) ? 'user' : 'app'}`,
    // No Astro telemetry state in the App Home (and no first-run notice).
    '-e', 'ASTRO_TELEMETRY_DISABLED=1',
  ];
}

/**
 * B12: the user an `inheritHome` sidecar runs as (`uid:gid`), or null when it
 * keeps its image user (a root installation). A template `user` other than
 * this conflicts and is refused.
 */
export function inheritHomeUser(parent: SpawnIdentity | null | undefined): string | null {
  if (isApprovedRootIdentity(parent) || isNonRootIdentity(parent)) return `${parent!.uid}:${parent!.gid}`;
  return null;
}

/** What the sidecar policy needs to know about a sidecar spec. */
export interface SidecarIdentitySpec {
  image: string;
  inheritHome?: boolean;
  user?: string;
}

/**
 * A sidecar's identity (P5-3; B12, D107). A sidecar without the app's home
 * keeps its image user, or the manifest's `services[].user`. A sidecar that
 * inherits the app's home (`inheritHome`) works on the app's files, whatever
 * its image, so it runs as the app's own identity, never more:
 *   - an app identity (non-root): that uid:gid, no capabilities,
 *     no-new-privileges; an `aura-base` image also gets the identity files
 *     (a foreign image keeps its own /etc/passwd);
 *   - an approved root request: uid 0 without capabilities, like the app;
 *   - a root installation (legacy, no app identity yet): the image's own user,
 *     without capabilities and with no-new-privileges.
 * A template `user` that conflicts with it is refused by the kernel before
 * this runs (SidecarManager, D105). An image that can't run under the
 * identity fails its start with its own words: never retried as root.
 */
export function sidecarIdentityArgs(
  spec: SidecarIdentitySpec, parent: SpawnIdentity | null | undefined, opts: ContainerIdentityOpts & { baseImage: string },
): string[] {
  if (!spec.inheritHome) return [];
  // Under an approved root request: uid 0 without capabilities, like the app.
  if (isApprovedRootIdentity(parent)) return processIdentityFlags(parent!);
  // A root installation: never more than root without capabilities (its image user, nothing granted).
  if (!isNonRootIdentity(parent)) return ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];
  return [...processIdentityFlags(parent), ...(spec.image === opts.baseImage ? identityFileMounts(opts.appDataVolume, opts.instanceId) : [])];
}

/**
 * A PRoot app process's identity (Phase 5 R2, Q18b). PRoot shares the master's
 * kernel view: a root tracee reaches every Private Home, `/workspace`, the
 * socket and the secrets through `/proc/1/root`, whatever is bound. So a PRoot
 * app runs only under its installation's app identity (D70 app range), where
 * the kernel closes those paths; a root installation is refused, never run as
 * root (no fallback, D75).
 */
export class ProotIdentityError extends Error {
  override readonly name = 'ProotIdentityError';
}

export function requireProotIdentity(appId: string, identity: SpawnIdentity | undefined | null): SpawnIdentity {
  if (isNonRootIdentity(identity) && identity.range === 'app') return identity;
  throw new ProotIdentityError(
    `${appId}: PRoot runs an app only under its own app identity (a root process in the master reaches every home, `
    + `/workspace and the secrets), and this installation runs as ${identity && identity.uid !== 0 ? `uid ${identity.uid}` : 'root'}: `
    + `not started. Run it as its app identity (\`aura admin apps run-as ${appId} app\`) or on the container runtime.`);
}

/**
 * How the runner drops to the app identity before `proot` (the master's
 * util-linux `setpriv`): real, effective and saved uid/gid, no supplementary
 * groups (so no `docker` group), no-new-privileges. Root loses every
 * capability on the uid change. Plus the identity files bound over the
 * rootfs's own, and the env the container identity sets too.
 */
export function prootIdentityLaunch(identity: SpawnIdentity, identityDir: string): {
  command: string; prefix: string[]; binds: string[]; env: Record<string, string>;
} {
  return {
    command: 'setpriv',
    prefix: [`--reuid=${identity.uid}`, `--regid=${identity.gid}`, '--clear-groups', '--no-new-privs', '--'],
    binds: [`--bind=${join(identityDir, 'passwd')}:/etc/passwd`, `--bind=${join(identityDir, 'group')}:/etc/group`],
    env: { AURA_RUN_AS: 'app', ASTRO_TELEMETRY_DISABLED: '1' },
  };
}
