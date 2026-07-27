/**
 * The PocketBuilder → project transport.
 *
 * WHY THIS EXISTS
 * ---------------
 * Container-sandbox apps get a SLICED bind of the OS filesystem: inside
 * `aura-<instanceId>` only `/workspace/apps/<own-id>` exists, and `/data` is
 * mounted with `volume-subpath=<own instance dir>` (see
 * packages/core/src/app-manager/ContainerRunner.ts — `buildAppDirMount` and
 * the `--mount` block in `buildDockerArgs`). PocketBuilder therefore CANNOT
 * see the directories of the projects it creates through its own filesystem.
 *
 * It reaches them through the docker socket instead — the manifest declares
 * `tools: ["docker"]`, which is what makes the OS bind-mount
 * /var/run/docker.sock (same mechanism com.aura.whisper and com.aura.registry
 * use for their sibling containers). Two paths:
 *
 *   • project RUNNING  → `docker exec` straight into `aura-<instanceId>`,
 *                        where the project dir is already at
 *                        /workspace/apps/<projectId>.
 *   • project STOPPED  → a throwaway `docker run --rm` helper that mounts
 *                        ONLY that project's subpath of the shared app-data
 *                        volume. Works before the project has ever booted.
 *
 * Both paths pass argv arrays to docker — nothing is ever interpolated into a
 * shell string, so user input (commit messages, remote URLs) can't break out.
 */

import { execFile } from 'node:child_process';

/** Image used for the throwaway helper containers. Same default the SDK's
 *  SidecarHost uses for its seed helpers. */
const HELPER_IMAGE = process.env['AURA_BASE_IMAGE'] || 'aura-base';

/** Our own instance id, injected by ContainerRunner at spawn time. Used to
 *  find our own container and read the app-data volume name off it. */
const SELF_INSTANCE_ID = process.env['APP_INSTANCE_ID'] ?? '';

export interface ExecResult {
  ok:     boolean;
  code:   number;
  stdout: string;
  stderr: string;
  /** Which transport actually ran the command. Surfaced in the UI so a
   *  confusing result can be traced back to the right path. */
  via:    'exec' | 'helper';
}

/** Docker container name for an instance — mirrors ContainerRunner.containerName. */
export function containerName(instanceId: string): string {
  return 'aura-' + instanceId.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function docker(args: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number'
        ? (err as unknown as { code: number }).code
        : err ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err?.message ?? '')) });
    });
  });
}

interface DockerMount { Type?: string; Name?: string; Destination?: string }

let cachedVolume: string | null = null;

/**
 * Name of the shared `aura-app-data` docker volume, discovered by inspecting
 * OUR OWN container and picking the volume mounted at /data. Same technique
 * the shell uses (`pickVolumeByDestination` in ContainerRunner.ts) — the
 * compose project name prefixes the volume (`aura_aura-app-data`), so it must
 * be discovered rather than hard-coded.
 */
export async function appDataVolume(): Promise<string> {
  if (cachedVolume) return cachedVolume;
  if (!SELF_INSTANCE_ID) throw new Error('APP_INSTANCE_ID is unset — not running inside an AuraOS container sandbox.');
  const self = containerName(SELF_INSTANCE_ID);
  const r = await docker(['inspect', '--format', '{{json .Mounts}}', self], 10_000);
  if (r.code !== 0) throw new Error(`docker inspect ${self} failed: ${r.stderr.trim()}`);
  let mounts: DockerMount[];
  try { mounts = JSON.parse(r.stdout.trim()) as DockerMount[]; }
  catch { throw new Error(`docker inspect ${self} returned unparseable mounts`); }
  const m = mounts.find((x) => x.Destination === '/data' && x.Type === 'volume' && !!x.Name);
  if (!m?.Name) throw new Error('No named volume mounted at /data — cannot reach project directories.');
  cachedVolume = m.Name;
  return cachedVolume;
}

/**
 * Path of a project inside the app-data volume, e.g.
 * `scopes/users/default/apps/io.lakner.demo`. Derived from the scope's
 * appsDir (GET /api/scopes) rather than hard-coded, so a future relocation of
 * the user scope doesn't silently break the helper path.
 */
export function volumeSubpath(scopeAppsDir: string, projectId: string): string {
  const dataDir = process.env['AURA_DATA_DIR'] ?? '/data';
  const prefix = scopeAppsDir.startsWith(dataDir + '/') ? dataDir : '/data';
  if (!scopeAppsDir.startsWith(prefix + '/')) {
    throw new Error(`Scope appsDir '${scopeAppsDir}' is not inside ${prefix} — the helper-container path only works for volume-backed scopes.`);
  }
  return `${scopeAppsDir.slice(prefix.length).replace(/^\/+/, '')}/${projectId}`;
}

/** Run argv inside a RUNNING project container, cwd = the project dir. */
async function execInInstance(instanceId: string, projectId: string, argv: string[], timeoutMs: number): Promise<ExecResult> {
  const r = await docker(
    ['exec', '-w', `/workspace/apps/${projectId}`, containerName(instanceId), ...argv],
    timeoutMs,
  );
  return { ok: r.code === 0, code: r.code, stdout: r.stdout, stderr: r.stderr, via: 'exec' };
}

/** Run argv in a throwaway container that mounts only this project's dir at /proj. */
async function execInProjectDir(subpath: string, argv: string[], timeoutMs: number): Promise<ExecResult> {
  const volume = await appDataVolume();
  const r = await docker([
    'run', '--rm',
    '--mount', `type=volume,source=${volume},target=/proj,volume-subpath=${subpath}`,
    '-w', '/proj',
    HELPER_IMAGE,
    ...argv,
  ], timeoutMs);
  return { ok: r.code === 0, code: r.code, stdout: r.stdout, stderr: r.stderr, via: 'helper' };
}

export interface RunTarget {
  projectId: string;
  /** Instance id of a live container, if the project is running. */
  instanceId?: string | null;
  /** Host-side apps dir of the scope the project lives in (from /api/scopes). */
  scopeAppsDir: string;
}

/**
 * Run argv against a project, picking the transport automatically.
 *
 * The exec path is tried first when an instance id is known; if the container
 * turned out to be gone (raced with a stop, or the instance record is stale)
 * we silently fall back to the helper rather than surfacing a docker error
 * the user can do nothing about.
 */
export async function runInProject(target: RunTarget, argv: string[], timeoutMs = 120_000): Promise<ExecResult> {
  if (target.instanceId) {
    const r = await execInInstance(target.instanceId, target.projectId, argv, timeoutMs);
    const gone = !r.ok && /No such container|is not running/i.test(r.stderr);
    if (!gone) return r;
  }
  return execInProjectDir(volumeSubpath(target.scopeAppsDir, target.projectId), argv, timeoutMs);
}

/**
 * Install a freshly scaffolded project's dependencies before its first boot.
 *
 * Why this is not optional: the sandbox's synthesised entrypoint
 * (ContainerRunner.SYNTHESISED_ENTRYPOINT) runs `npm install` on first start
 * for user-scope apps, then `aura sdk install` to pull `@aura/*` from the local
 * OCI registry — and only then starts astro. A cold `npm install` of astro
 * takes well over the OS's 60s health window, so the very first
 * `POST /api/apps/<id>/start` is killed mid-install. The work persists to the
 * volume, so a second start succeeds — but "create then start fails once" is a
 * terrible first run.
 *
 * Doing it here, at create time, keeps the cost where the user expects it (the
 * create spinner) and makes the first start behave like every subsequent one.
 *
 * The helper needs three things the default helper mount doesn't give it:
 *   • the toolchain bin dir, so `aura` is on PATH;
 *   • the `/workspace/packages` bind, because the `aura` shim is a launcher
 *     that execs `/workspace/packages/aura-cli/dist/aura.cjs`;
 *   • a network, to reach npm and the OCI registry.
 */
export async function prepareProject(scopeAppsDir: string, projectId: string): Promise<ExecResult> {
  const subpath = volumeSubpath(scopeAppsDir, projectId);
  const volume  = await appDataVolume();
  // Bind sources resolve on the HOST daemon, not inside this container — the
  // same rewrite ContainerRunner does with AURA_HOST_WORKSPACE.
  const hostWorkspace = process.env['AURA_HOST_WORKSPACE'] ?? '/workspace';
  const r = await docker([
    'run', '--rm',
    '--mount', `type=volume,source=${volume},target=/proj,volume-subpath=${subpath}`,
    '--mount', `type=volume,source=${volume},target=/aura/all-tools,volume-subpath=aura/toolchain/bin,readonly`,
    '-v', `${hostWorkspace}/packages:/workspace/packages:ro`,
    '--network', process.env['AURA_DOCKER_NETWORK'] || 'aura-net',
    '-w', '/proj',
    '-e', 'PATH=/aura/all-tools:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HELPER_IMAGE,
    'sh', '-c', 'npm install --prefer-offline && aura sdk install --quiet',
  ], 600_000);
  return { ok: r.code === 0, code: r.code, stdout: r.stdout, stderr: r.stderr, via: 'helper' };
}

/**
 * Force-remove every sibling container a project spawned.
 *
 * The normal teardown path is the project's own `onDestroy` hook calling
 * `teardownAll()`. That never runs when an instance is force-killed
 * (`POST /api/instances/<id>/kill`) or when the container dies unexpectedly —
 * and because sidecars are declared `restart: unless-stopped`, the sibling
 * keeps running with no parent. Restarting the project adopts the orphan
 * again (ensure() matches on container name), so that state is self-healing.
 *
 * Deleting the project is where it stops being self-healing: the app is gone,
 * nothing will ever adopt the container, and it survives with a volume nobody
 * references. So delete sweeps by the `aura.parent` label the SDK stamps on
 * every sibling it starts.
 */
export async function removeSiblings(projectId: string): Promise<string[]> {
  const list = await docker(['ps', '-aq', '--filter', `label=aura.parent=${projectId}`], 15_000);
  const ids = list.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (ids.length) await docker(['rm', '-f', ...ids], 60_000);
  return ids;
}

/**
 * Delete a project's directory from the scope's apps dir.
 *
 * `POST /api/apps/<id>/remove` stops the instances and cleans up KV, but its
 * `rm -rf` targets the hard-coded system apps dir
 * (packages/shell/src/pages/api/apps/[id]/remove.ts) — for a user-scope app it
 * finds nothing and reports `removed: false`, leaving the directory (and thus
 * the app) in place. Nexus's uninstall can't help either: it requires an
 * install record, which scaffolded apps don't have.
 *
 * So we remove the directory ourselves through a helper container that mounts
 * the scope's apps dir. The shell's chokidar watcher (one per scope, see
 * AppRegistry) sees the `unlink` of app.manifest.json and deregisters the app.
 * If the OS's remove endpoint ever becomes scope-aware, this becomes a no-op.
 */
export async function removeProjectDir(scopeAppsDir: string, projectId: string): Promise<ExecResult> {
  // Reuse volumeSubpath's validation, then drop the trailing project segment:
  // we must mount the PARENT so the child can be unlinked.
  const parentSubpath = volumeSubpath(scopeAppsDir, projectId).replace(new RegExp(`/${projectId}$`), '');
  const volume = await appDataVolume();
  const r = await docker([
    'run', '--rm',
    '--mount', `type=volume,source=${volume},target=/apps,volume-subpath=${parentSubpath}`,
    HELPER_IMAGE,
    'rm', '-rf', `/apps/${projectId}`,
  ], 60_000);
  return { ok: r.code === 0, code: r.code, stdout: r.stdout, stderr: r.stderr, via: 'helper' };
}

/**
 * Run a git subcommand against a project.
 *
 * Identity is passed per-invocation with `-c` instead of relying on a global
 * git config, because the two transports run as different containers and
 * neither is guaranteed to have one. `safe.directory=*` is set because the
 * helper container mounts the tree as root while the files may be owned by a
 * different uid — git's dubious-ownership check would otherwise refuse.
 */
export async function git(target: RunTarget, args: string[], timeoutMs = 120_000): Promise<ExecResult> {
  const name  = process.env['GIT_AUTHOR_NAME']  || 'Pocket Builder';
  const email = process.env['GIT_AUTHOR_EMAIL'] || 'pocketbuilder@aura.local';
  return runInProject(target, [
    'git',
    '-c', 'safe.directory=*',
    '-c', `user.name=${name}`,
    '-c', `user.email=${email}`,
    ...args,
  ], timeoutMs);
}
