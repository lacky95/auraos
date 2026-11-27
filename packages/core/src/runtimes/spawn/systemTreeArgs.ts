/**
 * The system tree of a workload (Phase 6 L; D1–D4, D80, A7): where the parts
 * of the AuraOS tree a container sees come from (`/workspace/packages`, the
 * workspace root files, `.aura`, the AuraOS bashrc, a system app's source,
 * `node_modules`), and the daemon-side path of a shell path under
 * `/workspace`. The one place that knows both layouts; no other module holds
 * the host checkout path (`AURA_HOST_WORKSPACE`, D36):
 *
 *   checkout  Developer layout: today's host binds
 *             `-v <AURA_HOST_WORKSPACE>/<rel>:<target>[:ro]`, `node_modules`
 *             from the shell's named volume.
 *   release   Normal layout: the release inside the data volume,
 *             `--mount type=volume,source=<app-data>,volume-subpath=releases/<id>/<rel>,readonly`,
 *             ALWAYS read-only whatever the caller asks (D80: a release tree is
 *             never writable through any mount), with the release's own
 *             `node_modules`.
 *
 * Which one is decided by the layout the shell runs from, never by the
 * recorded mode: os/release-entry.sh makes `/workspace` a symlink to
 * `/releases/<id>` (a finished release, `.complete`). A checkout whose mode
 * file says `normal` keeps its checkout binds; Normal Mode is enforced from a
 * release only (shell `systemMode.ts` `normalEnforced`).
 *
 * A7: the host path never leaves the runtime layer (the container runtime's
 * argv and its mount helper's daemon paths). Foundation: node and the release
 * path contract only.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { COMPLETE_MARKER, OVERLAY_CAPABILITIES_FILE, RELEASES_DIR, RELEASE_ID_RE, RELEASE_RECORD, STAGING_PREFIX } from '../../release/paths.js';

/** Where the shell (and every workload) sees the AuraOS tree. */
export const WORKSPACE_DIR = '/workspace';
/** Where the Normal layout mounts the data volume's `releases/` read-only in the shell (docker-compose.release.yml). */
export const RELEASES_MOUNT = '/releases';
/**
 * Workspace root files an app container and an app build mount read-only
 * (`systemTreeSlice`). tsconfig.base.json because packages/<pkg>/tsconfig.json
 * extends it: Vite 8 (Astro 7) reads the tsconfig of every file it transforms
 * and fails on a missing `extends`.
 */
export const WORKSPACE_ROOT_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json'] as const;

export type SystemTree =
  /** Developer layout: the host checkout (`AURA_HOST_WORKSPACE`) and the shell's node_modules volume. */
  | { kind: 'checkout'; hostRoot: string; nodeModulesVolume: string; dataVolume?: string }
  /** Normal layout: release `releaseId` inside the data volume `dataVolume`. */
  | { kind: 'release'; releaseId: string; dataVolume: string };

/** The workspace dir of this process (`AURA_WORKSPACE_DIR`, default `/workspace`). */
export const workspaceDir = (env: Record<string, string | undefined> = process.env): string => env['AURA_WORKSPACE_DIR'] ?? WORKSPACE_DIR;

/**
 * The release this process serves, or null (the Developer layout): the
 * workspace dir resolves to `<…>/releases/<id>` and that release is complete.
 * `commit` from its `release.json` (null when unreadable).
 */
export function runningRelease(dir: string = workspaceDir()): { id: string; root: string; commit: string | null } | null {
  let real: string;
  try { real = realpathSync(dir); } catch { return null; }
  const id = basename(real);
  if (basename(dirname(real)) !== RELEASES_DIR || !RELEASE_ID_RE.test(id) || id.startsWith(STAGING_PREFIX)) return null;
  if (!existsSync(join(real, COMPLETE_MARKER))) return null;
  let commit: string | null = null;
  try {
    const c = (JSON.parse(readFileSync(join(real, RELEASE_RECORD), 'utf8')) as { commit?: unknown }).commit;
    if (typeof c === 'string') commit = c;
  } catch { /* no record: the id still names it */ }
  return { id, root: real, commit };
}

/** The system tree of this process (the volume names are the container runtime's, resolved from its own mounts). */
export function resolveSystemTree(
  volumes: { dataVolume: string; nodeModulesVolume: string },
  env: Record<string, string | undefined> = process.env,
): SystemTree {
  const release = runningRelease(workspaceDir(env));
  if (release) return { kind: 'release', releaseId: release.id, dataVolume: volumes.dataVolume };
  // The host path bound at /workspace (docker-compose.yml): sibling containers share the
  // host's filesystem, not the shell's view, so their bind sources are host paths.
  return { kind: 'checkout', hostRoot: env['AURA_HOST_WORKSPACE'] ?? WORKSPACE_DIR, nodeModulesVolume: volumes.nodeModulesVolume, dataVolume: volumes.dataVolume };
}

function assertRel(rel: string): void {
  if (!rel || rel.startsWith('/') || rel.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`not a path inside the system tree: ${JSON.stringify(rel)}`);
  }
}

/**
 * The args that mount `<rel>` of the system tree (relative to its root) at
 * `target`. `ro` applies to the checkout; a release is read-only always (D80).
 */
export function systemTreeMount(tree: SystemTree, rel: string, target: string, opts: { ro?: boolean } = {}): string[] {
  assertRel(rel);
  if (rel === '.aura') {
    const reg = capabilityRegistryMount(tree, target);
    if (reg) return reg;
  }
  if (tree.kind === 'checkout') return ['-v', `${tree.hostRoot}/${rel}:${target}${opts.ro === false ? '' : ':ro'}`];
  return ['--mount', `type=volume,source=${tree.dataVolume},target=${target},volume-subpath=${RELEASES_DIR}/${tree.releaseId}/${rel},readonly`];
}

/**
 * `.aura` (Phase 6 O): the EFFECTIVE capability registry, read-only at `<target>/capabilities.yaml`, from
 * the data volume's `aura/overlay/capabilities.yaml` (the release's registry + the owner's entries, which the
 * shell writes at boot before any app starts and rewrites in place: core capabilities/registryOverlay.ts), in
 * both layouts; never the release tree's own file. Null for a tree without a data volume (the checkout's old
 * bind of `.aura`).
 */
function capabilityRegistryMount(tree: SystemTree, target: string): string[] | null {
  if (!tree.dataVolume) return null;
  return ['--mount', `type=volume,source=${tree.dataVolume},target=${target}/capabilities.yaml,volume-subpath=${OVERLAY_CAPABILITIES_FILE},readonly`];
}

/** `node_modules` at `target`, read-only: the shell's named volume (checkout) or the release's own. */
export function systemTreeNodeModules(tree: SystemTree, target = `${WORKSPACE_DIR}/node_modules`): string[] {
  if (tree.kind === 'checkout') return ['--mount', `type=volume,source=${tree.nodeModulesVolume},target=${target},readonly`];
  return systemTreeMount(tree, 'node_modules', target);
}

/** The read-only slice of /workspace every app container and app build sees: the packages and the root files. */
export function systemTreeSlice(tree: SystemTree): string[] {
  return [
    ...systemTreeMount(tree, 'packages', `${WORKSPACE_DIR}/packages`),
    ...WORKSPACE_ROOT_FILES.flatMap((f) => systemTreeMount(tree, f, `${WORKSPACE_DIR}/${f}`)),
  ];
}

/** The tree-relative path of a shell path under /workspace (`''` for /workspace itself), or null. */
export function systemTreeRel(shellPath: string): string | null {
  if (shellPath === WORKSPACE_DIR) return '';
  if (!shellPath.startsWith(`${WORKSPACE_DIR}/`)) return null;
  const rel = shellPath.slice(WORKSPACE_DIR.length + 1);
  assertRel(rel);
  return rel;
}

/**
 * The daemon-side path of a shell path under /workspace, for a host-side bind
 * (the mount helper): `<hostRoot>/<rel>` (checkout) or
 * `<data volume mountpoint>/releases/<id>/<rel>` (release). Null when the path
 * is not under /workspace.
 */
export function systemTreeHostPath(tree: SystemTree, shellPath: string, dataVolumeMountpoint: () => string): string | null {
  const rel = systemTreeRel(shellPath);
  if (rel === null) return null;
  if (tree.kind === 'checkout') return rel ? `${tree.hostRoot}/${rel}` : tree.hostRoot;
  return join(dataVolumeMountpoint(), RELEASES_DIR, tree.releaseId, rel);
}

/**
 * Whether a shell path lies in a release tree (D80): the Normal layout's
 * read-only `/releases`, the data volume's `releases/`, or /workspace when the
 * shell runs from a release. A writable mount of such a path is refused, in
 * every mode.
 */
export function inReleaseTree(shellPath: string, dataDir: string): boolean {
  const real = realpathOfNearest(shellPath);
  return [RELEASES_MOUNT, realpathOfNearest(join(dataDir, RELEASES_DIR))].some((root) => real === root || real.startsWith(`${root}/`));
}

/** The real path of `p`, through its nearest existing ancestor when `p` itself does not exist yet. */
function realpathOfNearest(p: string): string {
  let rest = '';
  for (let cur = p; ; cur = dirname(cur)) {
    try { return join(realpathSync(cur), rest); } catch { /* go up */ }
    if (dirname(cur) === cur) return p;
    rest = rest ? join(basename(cur), rest) : basename(cur);
  }
}
