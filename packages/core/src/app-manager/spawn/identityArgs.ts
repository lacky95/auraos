/**
 * The process identity of an app container (Phase 5 stream A, P5-3).
 *
 * `root` (today, and every installation recorded before 5-apps): nothing is
 * added, the container runs as the image's root with Docker's default set.
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
 * There is no fallback: the runner never retries a failed non-root start as
 * root (P5-3). Sidecars keep their image user, except an `aura-base` sidecar
 * that inherits the app's home: it is the app's own code and runs as the app
 * (`sidecarIdentityArgs`).
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpawnIdentity } from '../../identity/types.js';
import { appAccountName, renderGroup, renderPasswd } from '../../identity/passwd.js';

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

/** The account name of a spawn identity: `app-<installation>` for an app identity. */
export function identityAccountName(identity: SpawnIdentity, installationId: string | null): string {
  if (identity.range === 'app' && installationId) return appAccountName(installationId);
  return `aura-${identity.range}-${identity.uid}`;
}

/** The rendered `/etc/passwd` and `/etc/group` of a non-root app container. Pure. */
export function renderIdentityFiles(identity: SpawnIdentity, installationId: string | null): { passwd: string; group: string } {
  const name = identityAccountName(identity, installationId);
  return {
    passwd: renderPasswd(BASE_PASSWD, [{ name, uid: identity.uid, gid: identity.gid, gecos: 'AuraOS app' }]),
    group: renderGroup(BASE_GROUP, [{ name, gid: identity.gid }]),
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

/** The `docker run` flags of an app container's identity; empty for root (today). */
export function containerIdentityArgs(identity: SpawnIdentity | undefined, opts?: ContainerIdentityOpts): string[] {
  if (!isNonRootIdentity(identity)) return [];
  if (!opts) throw new Error('a non-root app identity needs its identity files');
  return [
    ...processIdentityFlags(identity),
    ...identityFileMounts(opts.appDataVolume, opts.instanceId),
    '-e', 'AURA_RUN_AS=app',
    // No Astro telemetry state in the App Home (and no first-run notice).
    '-e', 'ASTRO_TELEMETRY_DISABLED=1',
  ];
}

/** What the sidecar policy needs to know about a sidecar spec. */
export interface SidecarIdentitySpec {
  image: string;
  inheritHome?: boolean;
  user?: string;
}

/**
 * A sidecar's identity (P5-3): it keeps its image user, or the manifest's
 * `services[].user`. The one exception by construction is an `aura-base`
 * sidecar that inherits the app's home (the Board supervisor): it is the
 * app's own code, so it runs as the app's identity, with the same flags.
 */
export function sidecarIdentityArgs(
  spec: SidecarIdentitySpec, parent: SpawnIdentity | null | undefined, opts: ContainerIdentityOpts & { baseImage: string },
): string[] {
  if (spec.user || !spec.inheritHome || spec.image !== opts.baseImage || !isNonRootIdentity(parent)) return [];
  return [...processIdentityFlags(parent), ...identityFileMounts(opts.appDataVolume, opts.instanceId)];
}
