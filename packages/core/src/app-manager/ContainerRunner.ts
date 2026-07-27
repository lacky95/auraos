import { spawn, spawnSync, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { AppManifest } from '../types/manifest.js';
import { lifecyclePath } from '../types/manifest.js';
import { toolsGrant } from './tool-allowlist.js';
import { MY_TOOLS_PATH, currentToolsMode, provisionAllowlist, toolchainMirrorBin } from './tool-provision.js';
// Value import, but MountManager imports ContainerRunner type-only, so there
// is no runtime cycle.
import { MOUNT_ROOT_PATH } from './MountManager.js';
import type { SandboxRunner, SandboxRunnerOpts } from './SandboxRunner.js';
import type { SpawnContext } from '../scopes/types.js';
import { ContextStore } from '../context/ContextStore.js';

const HEALTH_CHECK_INTERVAL_MS = 200;
const HEALTH_CHECK_TIMEOUT_MS = 60_000; // slightly higher than PRoot because container spawn adds ~100 ms
const LIFECYCLE_TIMEOUT_MS = 5_000;
const SHARED_NETWORK = process.env['AURA_DOCKER_NETWORK'] ?? 'aura-net';
const BASE_IMAGE     = process.env['AURA_BASE_IMAGE']     ?? 'aura-base';

/** One entry of `docker inspect`'s `.Mounts` array (only the fields we read). */
interface DockerMount {
  Type?: string;
  Name?: string;
  Source?: string;
  Destination?: string;
}

/**
 * Pick the NAMED-volume name attached at `destination` from a docker inspect
 * `.Mounts` array. Returns undefined when there is no such mount or it is a
 * bind mount (which has no volume name). Pure — unit-tested in
 * test/container-volume.test.mjs.
 */
export function pickVolumeByDestination(mounts: DockerMount[], destination: string): string | undefined {
  const m = mounts.find((x) => x.Destination === destination && x.Type === 'volume' && !!x.Name);
  return m?.Name;
}

const SYNTHESISED_ENTRYPOINT = `set -e
export PORT="\${APP_PORT:-4001}"
# Resolve astro. System-scope apps inherit it from the workspace's hoisted
# /workspace/node_modules/.bin/astro (the workspace pnpm install populated
# this via the mounted named volume). User/global-scope apps live outside
# the pnpm workspace; they have to install astro into their own
# node_modules. Run npm install only when neither path has astro yet.
if [ ! -x "node_modules/.bin/astro" ] && [ ! -x "/workspace/node_modules/.bin/astro" ]; then
  echo "[\${APP_ID:-app}] npm install (astro not yet present)..."
  npm install --prefer-offline 2>&1 || npm install
fi
# Pull @aura/* SDK packages from the local OCI registry when the app
# references them in \`auraDependencies\` (user/global scope) or legacy
# \`dependencies\` and the workspace symlinks didn't materialise them.
# No-op for system-scope apps where pnpm already populated
# /workspace/node_modules/@aura/* via workspace:*.
if [ ! -d node_modules/@aura ] && grep -qE '"(aura)?[dD]ependencies"|"@aura/' package.json 2>/dev/null; then
  command -v aura >/dev/null && aura sdk install --quiet || true
fi
ASTRO="node_modules/.bin/astro"
[ -x "\$ASTRO" ] || ASTRO="/workspace/node_modules/.bin/astro"
echo "[\${APP_ID:-app}] Starting Astro server on port \$PORT via \$ASTRO"
exec "\$ASTRO" dev --host 0.0.0.0 --port "\$PORT"`;

interface TrackedContainer {
  /** docker container ID (long form). */
  containerId: string;
  /** Hostname siblings reach this container by — `aura-<sanitized-instanceId>`. */
  hostname: string;
  port: number;
  appId: string;
  /** `docker logs --follow` child process so we can stream stdout/stderr into the shell's. */
  logTail: ChildProcess | null;
  /** Cached pid of the root process inside the container (from `docker inspect`). */
  pid: number;
  /** Best-effort exit callback registered by AppManager. */
  exitCb: ((code: number | null) => void) | null;
  /**
   * Set true by kill()/forceKill() right before sending docker stop/kill.
   * handleExit checks it and skips firing exitCb when true — the AppManager
   * is already in the middle of its own stop sequence and doesn't want a
   * stray "unexpected exit" event flipping the instance to 'error', which
   * would then break the next FSM transition to 'destroyed' and 500 the
   * /api/instances/X/stop response.
   */
  expectingKill: boolean;
  /** Cached manifest snapshot for lifecycle URL building. See ProotRunner's
   *  SpawnedApp.manifest field for the rationale (raw-mode basePath apps
   *  need the proxy prefix prepended to lifecycle URLs). */
  manifest: AppManifest;
}

/**
 * Docker-based sandbox runner. Each instance is a sibling container of the
 * AuraOS shell, started from the same base image (`aura-base`), parameterised
 * with env + sliced bind mounts that mirror what ProotRunner sets up.
 *
 * Key differences vs ProotRunner:
 *  • Spawn cost is ~80-150 ms (docker run) instead of ~3 ms (proot exec).
 *    Warm-pool covers this perceived-wise; cold spawn is still ~3-5 s end-to-
 *    end because astro dev dominates.
 *  • Real kernel namespaces — `cd /workspace/apps` only shows this app's own
 *    folder because we bind ONLY apps/<id>, not the whole /workspace/apps.
 *  • Apps reach the shell via `OS_API_BASE=http://aura-shell:3000` over the
 *    shared docker network instead of `127.0.0.1:3000`.
 *  • The container is named `aura-<instanceId>` and joins the shared
 *    `aura-net` network; the shell talks to it by name (no host port mapping
 *    needed, which would have to dance around port collisions across
 *    long-lived AuraOS sessions).
 *
 * Cleanup is automatic — every container is started with `--rm`, so when the
 * astro process inside exits (or we `docker kill`), the container disappears.
 */
export class ContainerRunner implements SandboxRunner {
  private containers = new Map<string, TrackedContainer>();
  private toolchainDir: string;
  private appsDir: string;
  private dataDir: string;
  private osApiBase: string;
  /** Public name the shell uses for itself on the shared docker network. */
  private shellHostname: string;
  private workspaceRoot: string;
  /** Named volume backing /data (app-data). Resolved once at construction. */
  private appDataVolume!: string;
  /** Named volume backing /workspace/node_modules. Resolved once. */
  private nodeModulesVolume!: string;
  /** OS-wide env/secret store, injected into every container. */
  private contextStore: ContextStore;

  constructor(opts: SandboxRunnerOpts) {
    this.toolchainDir = opts.toolchainDir;
    this.appsDir      = opts.appsDir;
    this.dataDir      = opts.dataDir;
    this.osApiBase    = opts.osApiBase;
    this.contextStore = new ContextStore(opts.dataDir);
    // Apps need to call back into the shell over the shared network. If
    // osApiBase points at 127.0.0.1 (the PRoot-compatible default), rewrite
    // it to the shell's docker hostname so sibling containers can reach it.
    this.shellHostname = process.env['AURA_SHELL_HOSTNAME'] ?? 'aura-shell';
    if (this.osApiBase.includes('127.0.0.1') || this.osApiBase.includes('localhost')) {
      this.osApiBase = this.osApiBase.replace(/(127\.0\.0\.1|localhost)/, this.shellHostname);
    }
    // workspaceRoot is the HOST path that should be bind-mounted into the
    // app container at /workspace. Sibling containers share the host fs, so
    // bind sources have to be host paths, not paths inside the AuraOS
    // container. The env var defaults to /workspace which works when the
    // AuraOS container itself was started with `-v <hostpath>:/workspace`
    // and the host path matches inside both containers (the common dev
    // setup). For non-dev shape this needs to be set explicitly.
    this.workspaceRoot = process.env['AURA_HOST_WORKSPACE'] ?? '/workspace';
    void opts.baseRootfs; // unused — containers bring their own rootfs via the image
    this.ensureNetwork();
    this.resolveVolumeNames();
  }

  // ─── Tool-allowlist dir (shared semantics with PRoot) ─────────────────
  public toolsDir(instanceId: string): string {
    return join(this.dataDir, 'aura', 'runtime', instanceId, 'tools');
  }
  public provisionToolsDir(instanceId: string, manifest: AppManifest): string {
    const dir = this.toolsDir(instanceId);
    provisionAllowlist({
      dataDir: this.dataDir,
      dir,
      tools: manifest.tools,
      // Containers can't see /os/toolchain (it exists only in the shell's
      // mount namespace), so their /aura/all-tools mount — and therefore
      // legacy symlink-mode enumeration — comes from the in-volume mirror.
      legacyStoreBin: toolchainMirrorBin(this.dataDir),
    });
    return dir;
  }
  public clearToolsDir(instanceId: string): void {
    try { rmSync(this.toolsDir(instanceId), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // ─── Cross-app mount root ─────────────────────────────────────────────
  /**
   * Per-instance root that `MountManager` binds other apps' dirs into. Mounted
   * as a volume-subpath (NOT a `-v` bind) because docker leaves volume mounts
   * as slaves of the host peer group, which is what lets a host-side bind
   * propagate into the already-running container. A plain `-v` bind arrives
   * `private` and would receive nothing.
   *
   * Empty for apps that never mount anything — it costs one empty dir, and
   * creating it unconditionally means granting the ability later doesn't
   * require a respawn (which would defeat the point of live mounting).
   */
  public mountRootDir(instanceId: string): string {
    return join(this.dataDir, 'aura', 'mounts', instanceId);
  }
  public mountRootSubpath(instanceId: string): string {
    return `aura/mounts/${instanceId}`;
  }
  public clearMountRoot(instanceId: string): void {
    try { rmSync(this.mountRootDir(instanceId), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // ─── Spawn ────────────────────────────────────────────────────────────
  async spawn(instanceId: string, appId: string, port: number, manifest: AppManifest, ctx: SpawnContext): Promise<number> {
    this.provisionToolsDir(instanceId, manifest);

    const hostname = this.containerName(instanceId);
    // Remove any stale container with the same name (orphaned by a previous
    // crash); --rm would have cleaned a normal exit, but `kill -9` of the
    // shell can leave them behind.
    try { execSync(`docker rm -f ${hostname}`, { stdio: 'ignore', timeout: 5_000 }); } catch { /* didn't exist */ }

    // Resolve OS Context (env/secret) LIVE from Redis on every spawn so a
    // respawned app always sees current values (the master never restarts,
    // never caches these). ensureDir guarantees the volume-subpath mount
    // source exists even before the first `set`.
    this.contextStore.ensureDir();
    const contextEnv = await this.contextStore.resolveEnv();

    const args = this.buildDockerArgs(instanceId, appId, port, manifest, hostname, ctx, contextEnv);
    console.log(`[ContainerRunner] Spawning ${hostname} (app=${appId}) on port ${port}`);

    // Use spawnSync (not execSync with a joined string) so multi-word args
    // like `bash -c '<SYNTHESISED_ENTRYPOINT>'` don't get re-split by the
    // shell — every entry in `args` ends up as a separate argv slot.
    const r = spawnSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, encoding: 'utf-8' });
    if (r.status !== 0) {
      throw new Error(`docker run failed for ${instanceId} (status=${r.status}): ${r.stderr?.trim() || r.error?.message || 'no stderr'}`);
    }
    const containerId = (r.stdout ?? '').trim();
    if (!containerId) throw new Error(`docker run for ${instanceId} returned no container id`);

    // Fan-out container stdout/stderr into the shell's log so `docker logs`
    // isn't the only place to see app output. Survives until the container
    // exits or we kill it.
    const logTail = spawn('docker', ['logs', '-f', containerId], { stdio: ['ignore', 'pipe', 'pipe'] });
    logTail.stdout?.on('data', (d: Buffer) => process.stdout.write(`[${instanceId}] ${d}`));
    logTail.stderr?.on('data', (d: Buffer) => process.stderr.write(`[${instanceId}] ${d}`));

    // `docker inspect` for the pid; useful for orphan-reaper accounting.
    let pid = 0;
    try {
      const out = execSync(`docker inspect -f '{{.State.Pid}}' ${containerId}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      pid = parseInt(out, 10) || 0;
    } catch { /* leave 0; reaper will ignore */ }

    const tracked: TrackedContainer = { containerId, hostname, port, appId, logTail, pid, exitCb: null, expectingKill: false, manifest };
    this.containers.set(instanceId, tracked);

    // Watch for container exit so we can fire the exit callback.
    const watcher = spawn('docker', ['wait', containerId], { stdio: ['ignore', 'pipe', 'ignore'] });
    watcher.stdout?.on('data', (d: Buffer) => {
      const code = parseInt(d.toString().trim(), 10);
      this.handleExit(instanceId, isNaN(code) ? null : code, containerId);
    });
    watcher.on('error', () => this.handleExit(instanceId, null, containerId));

    try {
      await this.waitHealthy(instanceId, appId, hostname, port, manifest);
    } catch (err) {
      console.error(`[ContainerRunner] ${instanceId} health-check failed: ${(err as Error).message}`);
      this.forceKill(instanceId);
      throw err;
    }
    return pid;
  }

  /**
   * Translate an in-container path under /workspace to its equivalent host
   * path so docker bind-mount sources resolve correctly when the daemon
   * runs in a separate filesystem namespace (Docker Desktop / Rancher
   * Desktop / OrbStack on macOS, or any rootless setup). On a Linux host
   * where workspaceRoot===/workspace this is a no-op.
   */
  private toHostPath(inContainerPath: string): string {
    if (inContainerPath === '/workspace') return this.workspaceRoot;
    if (inContainerPath.startsWith('/workspace/')) {
      return this.workspaceRoot + inContainerPath.slice('/workspace'.length);
    }
    return inContainerPath;
  }

  /**
   * Mountpoint of the app-data named volume as the DAEMON sees it (e.g.
   * `/var/lib/docker/volumes/aura_aura-app-data/_data`). Cached — a volume's
   * mountpoint is fixed for its lifetime.
   *
   * Needed because cross-app mounting (`MountManager`) performs a host-side
   * `mount --bind`, which needs a real daemon-visible path. The rest of the
   * runner never needs this: it hands docker a volume NAME plus a
   * `volume-subpath` and lets the daemon resolve it.
   */
  private volumeMountpointCache: string | null = null;
  public appDataVolumeMountpoint(): string {
    if (this.volumeMountpointCache) return this.volumeMountpointCache;
    const out = execSync(
      `docker volume inspect -f '{{.Mountpoint}}' ${this.appDataVolume}`,
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, encoding: 'utf-8' },
    ).trim();
    if (!out) throw new Error(`could not resolve mountpoint for volume ${this.appDataVolume}`);
    this.volumeMountpointCache = out;
    return out;
  }

  /**
   * Translate a SHELL-side path (under /workspace or /data) to the path the
   * docker daemon sees. Mirrors `buildAppDirMount`'s scope dispatch, but
   * yields a plain host path instead of docker args:
   *
   *   - `/workspace/...` (system scope)      → `toHostPath` → `<workspaceRoot>/...`
   *   - `<dataDir>/...`  (user/global scope) → `<volumeMountpoint>/...`
   *
   * Throws on anything else rather than guessing — a wrong bind source here
   * would mount the wrong app's files, which is worse than a hard failure.
   */
  public toDaemonHostPath(shellPath: string): string {
    if (shellPath === '/workspace' || shellPath.startsWith('/workspace/')) {
      return this.toHostPath(shellPath);
    }
    for (const prefix of [this.dataDir, '/data']) {
      if (shellPath === prefix || shellPath.startsWith(`${prefix}/`)) {
        const rel = shellPath.slice(prefix.length).replace(/^\/+/, '');
        return rel ? join(this.appDataVolumeMountpoint(), rel) : this.appDataVolumeMountpoint();
      }
    }
    throw new Error(`cannot resolve a daemon host path for ${shellPath}`);
  }

  /**
   * Whether this host can propagate mounts into running containers. The
   * `/data` mount must be `shared:` or `master:` (a peer or slave of a host
   * peer group); a `private` mount receives nothing and cross-app mounting
   * would silently no-op. Cached after the first probe.
   */
  private propagationCache: { ok: boolean; reason?: string } | null = null;
  public canPropagateMounts(): { ok: boolean; reason?: string } {
    if (this.propagationCache) return this.propagationCache;
    let result: { ok: boolean; reason?: string };
    try {
      const info = readFileSync('/proc/self/mountinfo', 'utf-8');
      const line = info.split('\n').find((l) => l.split(' ')[4] === this.dataDir);
      if (!line) {
        result = { ok: false, reason: `no mount found at ${this.dataDir}` };
      } else {
        // Optional fields sit between field 6 and the '-' separator.
        const optional = line.split(' ').slice(6, line.split(' ').indexOf('-'));
        const shared = optional.some((f) => f.startsWith('shared:') || f.startsWith('master:'));
        result = shared
          ? { ok: true }
          : { ok: false, reason: `${this.dataDir} is a private mount — the host's / must be a shared mount (run: mount --make-rshared /)` };
      }
    } catch (err) {
      result = { ok: false, reason: `could not read /proc/self/mountinfo: ${(err as Error).message}` };
    }
    if (!result.ok) console.warn(`[ContainerRunner] mount propagation unavailable: ${result.reason}`);
    this.propagationCache = result;
    return result;
  }

  /** Build the `docker run` argv mirroring ProotRunner's bind topology. */
  private buildDockerArgs(
    instanceId: string,
    appId: string,
    port: number,
    manifest: AppManifest,
    hostname: string,
    ctx: SpawnContext,
    contextEnv: Record<string, string>,
  ): string[] {
    // myTools is only used to provision the per-instance symlinks before
    // docker run — the bind itself goes through aura-app-data's volume-subpath.
    void this.toolsDir(instanceId);
    // AppManager has already created ctx.instanceDataDir via mkdirSync before
    // calling spawn(), which also creates the subpath inside the named volume.
    const instDataDir = ctx.instanceDataDir;
    mkdirSync(instDataDir, { recursive: true });

    const entrypoint = this.resolveEntrypoint(ctx.appDir, appId, manifest);

    // node_modules + per-instance data live in the AuraOS named volumes,
    // not on the host bind (the AuraOS container's pnpm install populates
    // the named volume; the host's `./node_modules` is whatever was there
    // before compose). Sibling containers MUST mount those volumes by name
    // to see the same pnpm symlink targets the host pnpm install
    // generated. Names are resolved once in resolveVolumeNames() (discovered
    // from the shell's own mounts, so they match regardless of the compose
    // project name / directory).
    const nodeModulesVolume = this.nodeModulesVolume;
    const appDataVolume     = this.appDataVolume;
    // Subpath inside the app-data named volume — matches the layout the
    // AppManager creates via mkdirSync(instDataDir) below ("apps/<id>/<inst>",
    // NOT "aura/apps/..."). The dataDir is the mount point, not part of
    // the volume-internal path.
    // Compute subpath by stripping the root dataDir prefix from instanceDataDir.
    // For system apps: "scopes/system/apps/<id>/<inst>"
    // For global/user: "scopes/global/apps/<id>/<inst>" etc.
    const dataSubpath = instDataDir.slice(this.dataDir.length).replace(/^\//, '');

    // SLICED bind set — only this app's apps/<id> dir is visible at
    // /workspace/apps, with shared workspace dirs (node_modules, packages,
    // pnpm lockfiles) mounted alongside so pnpm symlinks resolve. Sibling
    // apps are genuinely invisible — `cd /workspace/apps` shows ONLY this
    // app's folder.
    //
    // Two paths depending on scope:
    //   • System-scope apps' source lives in the host's workspace, so we
    //     swap `/workspace` for AURA_HOST_WORKSPACE and do a plain `-v`
    //     bind (toHostAppDir).
    //   • User/global-scope apps live INSIDE the aura-app-data named
    //     volume (path inside-volume is e.g. scopes/users/default/apps/<id>).
    //     Sibling containers can't bind from the volume by host path — the
    //     volume's storage dir isn't a stable host path — so we use the
    //     same volume-subpath pattern already used for /data, /aura/*-tools,
    //     /home/aura below.
    const appDirMount = this.buildAppDirMount(ctx.appDir, appId, appDataVolume);
    // Cap allowlist mounts. We can't bind host paths here: /os/toolchain and
    // /data/... only exist inside the aura-shell mount namespace, but
    // sibling-container binds go through the HOST docker daemon, which would
    // create empty stubs on its rootfs. Instead we mount subpaths of the
    // aura-app-data named volume, populated from inside aura-shell (where
    // /data IS that volume).
    //
    //   • aura/runtime/<inst>/tools → /aura/my-tools — the per-instance
    //     allowlist provisionToolsDir() writes. Mounted READ-ONLY: it is only
    //     ever written from the shell side, and in hardlink mode its entries
    //     share inodes with the mirror, so a writable mount would let a
    //     container corrupt a binary for every app on the system.
    //   • aura/toolchain/bin → /aura/all-tools — the WHOLE toolchain. Mounted
    //     only in legacy symlink mode, where allowlist entries are symlinks
    //     that need this path to resolve against. In hardlink mode the
    //     allowlist entries are the binaries themselves, so mounting the store
    //     would hand every app every tool by absolute path and defeat the
    //     grant entirely.
    const toolsMode = currentToolsMode(this.dataDir);
    const toolMounts = [
      ...(toolsMode === 'symlink'
        ? ['--mount', `type=volume,source=${appDataVolume},target=/aura/all-tools,volume-subpath=aura/toolchain/bin,readonly`]
        : []),
      '--mount', `type=volume,source=${appDataVolume},target=${MY_TOOLS_PATH},volume-subpath=aura/runtime/${instanceId}/tools,readonly`,
    ];
    // Cross-app mount root. Docker requires the subpath to exist before `run`.
    // Deliberately NOT `readonly`: read-only-ness is a property of each child
    // bind (set by the source it was mounted from), and marking the parent
    // read-only neither propagates down nor prevents children being writable.
    mkdirSync(this.mountRootDir(instanceId), { recursive: true });
    toolMounts.push(
      '--mount', `type=volume,source=${appDataVolume},target=${MOUNT_ROOT_PATH},volume-subpath=${this.mountRootSubpath(instanceId)}`,
    );
    const a: string[] = [
      'run', '--rm', '-d',
      '--name', hostname,
      // Docker DNS uses --name for cross-container resolution (the proxy at
      // /api/proxy/<id> resolves to the aura-<instanceId> name), so --name
      // stays unique. --hostname is purely cosmetic — it surfaces as the
      // kernel hostname inside the container and feeds bash's `\h`. Setting
      // it to the appId gives a friendlier prompt like
      // `root@com.aura.counter:/workspace/apps/com.aura.counter$`. AURA_HOSTNAME
      // env (read by bashrc.aura.sh below) keeps the override discoverable
      // even when something resets `hostname`.
      '--hostname', appId,
      '--network', SHARED_NETWORK,
      '--workdir', `/workspace/apps/${appId}`,
      // Per-app slice of /workspace. Sibling apps in apps/<other> are not
      // visible — the individual app folder is bound directly, with no parent
      // /workspace/apps bind. buildAppDirMount dispatches on scope:
      //   • System scope: host-path bind. ctx.appDir (e.g. /workspace/apps/<id>)
      //     has its /workspace prefix rewritten to workspaceRoot, so bind
      //     sources resolve on the HOST daemon — a no-op on Linux
      //     (workspaceRoot==/workspace) and the correct rewrite for Mac VM-based
      //     daemons where /workspace doesn't exist outside the shell container.
      //   • User/global scope: volume-subpath mount of the aura-app-data volume.
      ...appDirMount,
      '-v', `${this.workspaceRoot}/packages:/workspace/packages:ro`,
      '-v', `${this.workspaceRoot}/package.json:/workspace/package.json:ro`,
      '-v', `${this.workspaceRoot}/pnpm-lock.yaml:/workspace/pnpm-lock.yaml:ro`,
      '-v', `${this.workspaceRoot}/pnpm-workspace.yaml:/workspace/pnpm-workspace.yaml:ro`,
      // node_modules from the AuraOS named volume (so peer-dep variants
      // match what pnpm installed inside the shell). --mount syntax
      // (not -v) is needed because we want a NAMED volume, not a bind.
      '--mount', `type=volume,source=${nodeModulesVolume},target=/workspace/node_modules,readonly`,
      // Per-instance state — subpath of the shared app-data volume so each
      // instance only sees ITS slice, not other instances'.
      '--mount', `type=volume,source=${appDataVolume},target=/data,volume-subpath=${dataSubpath}`,
      // Cap allowlist mounts — see toolMounts above.
      ...toolMounts,
      // AuraOS bash startup — bind the same script the PRoot base-rootfs gets.
      // Mounted into /etc/bash.bashrc (loaded by every interactive bash before
      // ~/.bashrc) so the PS1 + PATH customisation kicks in regardless of who
      // owns HOME. /etc/profile.d copy covers login shells.
      '-v', `${this.workspaceRoot}/os/bashrc.aura.sh:/etc/bash.bashrc:ro`,
      '-v', `${this.workspaceRoot}/os/bashrc.aura.sh:/etc/profile.d/aura-prompt.sh:ro`,
      // Shared user HOME across EVERY app container. The subpath is constant
      // (`aura/home/user`), so when the user logs into `claude` from the
      // terminal app, the same `~/.claude/` is visible after `aura jump`s
      // into another app — i.e. "the next container knows you". This is the
      // "one user, one home" model the user asked for; tighter per-app
      // isolation would mean each container only sees its own slice, but
      // here we explicitly prefer convenience over isolation (dev OS).
      // The dir is pre-created by AppManager.healToolchainShims so docker
      // can mount the subpath at container start.
      '--mount', `type=volume,source=${appDataVolume},target=/home/aura,volume-subpath=aura/home/user`,
      // OS Context (env vars / secrets). The master writes decrypted values to
      // /data/context/system/<KEY> (its view of the app-data volume); mounting
      // the same volume subpath here at /run/context read-only mirrors those
      // files live — a `set` reaches a RUNNING app on its next read, no respawn.
      '--mount', `type=volume,source=${appDataVolume},target=/run/context,volume-subpath=context/system,readonly`,
      // Identity + callback URL.
    ];

    // Bind host docker socket if the manifest asks for it (explicit 'docker'
    // in tools[] or the wildcard '*'). Matches ProotRunner's gating — needed
    // so commands like `aura jump` from inside a container app can drive
    // sibling-container spawns via the host daemon.
    const wantsDocker = toolsGrant(manifest.tools ?? [], 'docker');
    if (wantsDocker && existsSync('/var/run/docker.sock')) {
      a.push('-v', '/var/run/docker.sock:/var/run/docker.sock');
    }

    // OS Context env injection FIRST — the fixed OS vars below are pushed
    // after, so docker's last-wins semantics prevent a context key named e.g.
    // APP_ID / PATH / HOME from clobbering an OS-critical variable.
    for (const [k, v] of Object.entries(contextEnv)) a.push('-e', `${k}=${v}`);

    a.push(
      '-e', `APP_ID=${appId}`,
      '-e', `APP_INSTANCE_ID=${instanceId}`,
      '-e', `APP_PORT=${port}`,
      '-e', `OS_API_BASE=${this.osApiBase}`,
      '-e', `AURA_LAYER_TAG=[ctnr]`,
      // Hostname override read by bashrc.aura.sh's PS1. We also set the
      // kernel hostname via --hostname above, but a process can sethostname()
      // away from that; the env stays put across `docker exec` invocations
      // too, so `aura jump` shells reliably show the right name.
      '-e', `AURA_HOSTNAME=${appId}`,
      // Forward the master host name so the Terminal app's base shell can show
      // the host ("aura-shell") in its session-host indicator rather than its
      // own `--hostname <appId>` kernel name. Read by pty-server / index.astro.
      '-e', `AURA_SHELL_HOSTNAME=${this.shellHostname}`,
      // Point HOME at the shared persistent volume so tools like claude/gh/
      // ssh persist their state across container respawns AND across
      // `aura jump` hops between apps (one shared home, one logged-in user).
      '-e', `HOME=/home/aura`,
      // Terminal-capability env so TUI apps (claude, htop, vim, …) render
      // their rich versions. Without these, docker's default TERM=xterm
      // makes claude downgrade to a one-line greeting instead of the boxed
      // welcome card. `aura jump`'s docker exec adds them too as a belt-
      // and-suspenders; setting them here covers anything that bypasses
      // jump (e.g. the terminal app's pty-server spawning bash directly).
      '-e', `TERM=xterm-256color`,
      '-e', `COLORTERM=truecolor`,
      '-e', `LANG=C.UTF-8`,
      '-e', `LC_ALL=C.UTF-8`,
      '-e', `PATH=${MY_TOOLS_PATH}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      // Which allowlist mode the OS provisioned this instance with. Read by
      // @aura/app-sdk's sidecar host (`inheritTools`) so a sibling runtime
      // mounts the same set the OS gave the controlling app — and, in
      // hardlink mode, skips the shared /aura/all-tools mount instead of
      // silently re-opening the whole toolchain to the sibling.
      '-e', `AURA_TOOLS_MODE=${toolsMode}`,
      // Where cross-app mounts appear, so apps and the CLI can find them
      // without hardcoding a path the OS may move.
      '-e', `AURA_MOUNT_ROOT=${MOUNT_ROOT_PATH}`,
      BASE_IMAGE,
    );
    a.push(...entrypoint);
    void manifest; // unused — kept for future per-manifest customisation
    return a;
  }

  private resolveEntrypoint(appDir: string, appId: string, manifest: AppManifest): string[] {
    const entrypointPath = join(appDir, manifest.entrypoint);
    const entrypointExists = existsSync(entrypointPath);
    if (manifest.runtime === 'raw') {
      if (!entrypointExists) {
        throw new Error(
          `[ContainerRunner] app '${manifest.id}' has runtime: 'raw' but no entrypoint file at ${entrypointPath}. ` +
          `Raw apps must ship an executable entrypoint that binds the app to $APP_PORT.`,
        );
      }
      return ['bash', `/workspace/apps/${appId}/${manifest.entrypoint}`];
    }
    if (entrypointExists) return ['bash', `/workspace/apps/${appId}/${manifest.entrypoint}`];
    return ['bash', '-c', SYNTHESISED_ENTRYPOINT];
  }

  /** Build the `-v` / `--mount` args for binding an app's source dir into
   *  `/workspace/apps/<appId>` inside the sibling container. Two paths:
   *
   *  • System scope (ctx.appDir starts with `/workspace/`): the source
   *    lives on the host at `AURA_HOST_WORKSPACE/apps/<id>`. Plain `-v`
   *    bind works.
   *
   *  • User/global scope (ctx.appDir starts with `/data/`): the source
   *    lives INSIDE the `aura-app-data` named volume. Sibling Docker
   *    containers can't bind from a volume's storage path (it isn't a
   *    stable host path), so we use the same `--mount type=volume,
   *    volume-subpath=...` pattern already used for /data, /aura/*-tools,
   *    and /home/aura below.
   *
   *  Both paths produce the same in-container view: `/workspace/apps/<id>`. */
  private buildAppDirMount(ctxAppDir: string, appId: string, appDataVolume: string): string[] {
    const target = `/workspace/apps/${appId}`;
    if (ctxAppDir.startsWith('/workspace/')) {
      // toHostPath rewrites the /workspace prefix to AURA_HOST_WORKSPACE so the
      // bind source resolves on the HOST daemon (no-op on Linux, required for
      // Mac VM-based daemons).
      const hostPath = this.toHostPath(ctxAppDir);
      return ['-v', `${hostPath}:${target}`];
    }
    if (ctxAppDir.startsWith(`${this.dataDir}/`) || ctxAppDir.startsWith('/data/')) {
      // Strip the dataDir prefix to get the volume-internal path.
      const prefix = ctxAppDir.startsWith(this.dataDir + '/') ? this.dataDir : '/data';
      const subpath = ctxAppDir.slice(prefix.length).replace(/^\/+/, '');
      return ['--mount', `type=volume,source=${appDataVolume},target=${target},volume-subpath=${subpath}`];
    }
    // Unrecognised prefix — fall back to the plain bind and log. Most likely
    // a misconfigured scope; the bind will probably fail at container start.
    console.warn(`[ContainerRunner] unrecognised appDir prefix for ${appId}: ${ctxAppDir} — falling back to plain bind`);
    return ['-v', `${ctxAppDir}:${target}`];
  }

  private containerName(instanceId: string): string {
    // Docker names must be [a-zA-Z0-9_.-]; instance IDs are
    // "com.aura.terminal-3" — `.` is allowed but `:` (used in some
    // instanceId schemes) is not. Sanitise defensively.
    return 'aura-' + instanceId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  }

  /**
   * Find every running `aura-*` container that survived the shell's last
   * lifetime. AppManager.init() calls this so a docker-compose-restart of
   * aura-shell doesn't strand the user's container-mode apps as orphans
   * (no `getInstancesByApp` hit → no /aura/my-tools refresh on cap grant,
   * no autoStart/warmPool reconcile, no live state events in the desktop).
   * Each returned record is enough for AppManager to re-construct an
   * `AppInstance` in `state: 'resumed'` without a fresh spawn.
   *
   * The container's own environment is the source of truth: APP_ID +
   * APP_INSTANCE_ID + APP_PORT were set by buildDockerArgs at spawn time,
   * so reading them back is reliable even if the AppManager's instanceId
   * sanitisation ever changes.
   */
  /**
   * Belt-and-braces uninstall cleanup: remove every host container belonging to
   * this app — the single-instance `aura-<id>` and any multi `aura-<id>-<n>`
   * siblings — including ones AppManager no longer tracks. Anchored name match
   * so it never touches another app's containers.
   */
  public async killAllForApp(appId: string): Promise<void> {
    const base = 'aura-' + appId.replace(/[^a-zA-Z0-9_.-]/g, '_');
    let names: string[] = [];
    try {
      const out = execSync(`docker ps -a --filter "name=${base}" --format "{{.Names}}"`, {
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, encoding: 'utf-8',
      });
      names = out.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch (err) {
      console.warn(`[ContainerRunner] killAllForApp: docker ps failed: ${(err as Error).message}`);
      return;
    }
    // `--filter name=` is a substring match — keep only this app's exact
    // containers (base, or base-<n>), not e.g. `aura-<id>.other`.
    const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(-\\d+)?$');
    for (const n of names.filter((n) => re.test(n))) {
      try {
        execSync(`docker rm -f ${n}`, { stdio: 'ignore', timeout: 10_000 });
        console.log(`[ContainerRunner] killAllForApp: removed ${n} (app=${appId})`);
      } catch { /* already gone */ }
    }
    // Also reap any SIBLING runtime containers this app spawned (via the
    // @aura/app-sdk sidecar manager or hand-rolled `docker run`). They carry
    // an `aura.app=<appId>` label so we can find them even though their names
    // don't follow the `aura-<id>` scheme. Without this, a bring-your-own-
    // runtime app's siblings (e.g. `nousresearch/hermes-agent`) would leak on
    // uninstall.
    this.reapSiblings('aura.app', appId);
  }

  /**
   * Reap app-spawned sibling containers by label. Siblings are `docker run`
   * by an app (with the host socket) OUTSIDE AppManager's tracking; they are
   * labelled `aura.parent=<instanceId>` / `aura.app=<appId>` / `aura.service`
   * by the SDK so the OS can find and remove them. Idempotent.
   */
  private reapSiblings(labelKey: 'aura.parent' | 'aura.app', labelVal: string): void {
    let ids: string[] = [];
    try {
      const out = execSync(`docker ps -aq --filter "label=${labelKey}=${labelVal}"`, {
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, encoding: 'utf-8',
      });
      ids = out.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch (err) {
      console.warn(`[ContainerRunner] reapSiblings ${labelKey}=${labelVal}: docker ps failed: ${(err as Error).message}`);
      return;
    }
    for (const id of ids) {
      try {
        execSync(`docker rm -f ${id}`, { stdio: 'ignore', timeout: 10_000 });
        console.log(`[ContainerRunner] reaped sibling ${id} (${labelKey}=${labelVal})`);
      } catch { /* already gone */ }
    }
  }

  /** Remove sibling containers belonging to a specific instance. Public so
   *  AppManager can reap on graceful stop AND unexpected-exit (crash). */
  public reapSiblingsOf(instanceId: string): void {
    this.reapSiblings('aura.parent', instanceId);
  }

  public async listOrphanRecords(): Promise<Array<{
    instanceId: string;
    appId:      string;
    port:       number;
    hostname:   string;
    pid:        number;
  }>> {
    type DockerPsRow = { Names: string };
    type DockerInspect = { Config: { Env: string[]; Labels?: Record<string, string> }; State: { Pid: number } };
    let psOut: string;
    try {
      psOut = execSync(`docker ps --filter "name=aura-" --format "{{json .}}"`, {
        encoding: 'utf-8',
        timeout: 5_000,
      });
    } catch (err) {
      console.warn(`[ContainerRunner] adoption scan: docker ps failed: ${(err as Error).message}`);
      return [];
    }
    const lines = psOut.split('\n').map((l) => l.trim()).filter(Boolean);
    const out: Array<{ instanceId: string; appId: string; port: number; hostname: string; pid: number }> = [];
    for (const line of lines) {
      let row: DockerPsRow;
      try { row = JSON.parse(line) as DockerPsRow; }
      catch { continue; }
      if (!row.Names?.startsWith('aura-')) continue;
      // Skip aura-shell itself — it's not an app instance, just the
      // controller container that owns this runner.
      if (row.Names === 'aura-shell') continue;
      let inspect: DockerInspect;
      try {
        const raw = execSync(`docker inspect ${row.Names} --format "{{json .}}"`, {
          encoding: 'utf-8',
          timeout: 3_000,
        });
        inspect = JSON.parse(raw) as DockerInspect;
      } catch (err) {
        console.warn(`[ContainerRunner] inspect ${row.Names} failed: ${(err as Error).message}`);
        continue;
      }
      // App-spawned SIBLING runtime containers (labelled `aura.parent`) are not
      // AppManager instances — they belong to an app and are managed via
      // reapSiblings, not adopted as instances.
      if (inspect.Config?.Labels?.['aura.parent']) continue;
      const env: Record<string, string> = {};
      for (const kv of inspect.Config?.Env ?? []) {
        const i = kv.indexOf('=');
        if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      const appId      = env['APP_ID'];
      const instanceId = env['APP_INSTANCE_ID'];
      const portStr    = env['APP_PORT'];
      if (!appId || !instanceId || !portStr) continue;
      const port = parseInt(portStr, 10);
      if (!Number.isFinite(port) || port <= 0) continue;
      out.push({
        instanceId,
        appId,
        port,
        hostname: row.Names,
        pid: inspect.State?.Pid ?? 0,
      });
    }
    return out;
  }

  /**
   * After AppManager re-constructs an AppInstance from a `listOrphanRecords`
   * entry, this hooks the runner's bookkeeping (kill tracking, log streaming,
   * exit callback) up to the surviving container — same fields a fresh
   * `spawn()` would have set, just sourced from `docker inspect` rather than
   * a new `docker run`.
   */
  public registerAdopted(rec: {
    instanceId: string;
    appId:      string;
    port:       number;
    hostname:   string;
    pid:        number;
    manifest:   AppManifest;
  }): void {
    if (this.containers.has(rec.instanceId)) return;
    // We don't have the container ID handy — docker inspect would have it,
    // but the bookkeeping methods that need it (kill/forceKill/wait/logs)
    // accept the name as a fallback. Set containerId = name; docker accepts either.
    const logTail = spawn('docker', ['logs', '-f', '--tail', '0', rec.hostname], { stdio: ['ignore', 'pipe', 'pipe'] });
    logTail.stdout?.on('data', (d: Buffer) => process.stdout.write(`[${rec.instanceId}] ${d}`));
    logTail.stderr?.on('data', (d: Buffer) => process.stderr.write(`[${rec.instanceId}] ${d}`));
    this.containers.set(rec.instanceId, {
      containerId:   rec.hostname,
      hostname:      rec.hostname,
      port:          rec.port,
      appId:         rec.appId,
      logTail,
      pid:           rec.pid,
      exitCb:        null,
      expectingKill: false,
      manifest:      rec.manifest,
    });
    // CRITICAL for restart stability: watch the adopted container for exit,
    // exactly like spawn() does. Without this, if an adopted container dies
    // (crash, or an external `docker rm`), AppManager never learns — the
    // instance stays stuck in `resumed`, `start` reuses the phantom and
    // no-ops, and the app can't be recovered without a full shell restart.
    const watcher = spawn('docker', ['wait', rec.hostname], { stdio: ['ignore', 'pipe', 'ignore'] });
    watcher.stdout?.on('data', (d: Buffer) => {
      const code = parseInt(d.toString().trim(), 10);
      this.handleExit(rec.instanceId, isNaN(code) ? null : code, rec.hostname);
    });
    watcher.on('error', () => this.handleExit(rec.instanceId, null, rec.hostname));
  }

  /** Probe the app's health endpoint until ready or timeout. */
  private async waitHealthy(instanceId: string, appId: string, hostname: string, port: number, manifest: AppManifest): Promise<void> {
    const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;
    const healthUrl = `http://${hostname}:${port}${lifecyclePath(manifest, instanceId, 'health')}`;
    let lastBody: string | null = null;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(healthUrl);
        // Capture body regardless of status so the timeout error message
        // surfaces what the app actually said (403 = host gate, etc.).
        const body = await res.text();
        lastBody = body;
        if (res.ok) {
          // Identity check parallels ProotRunner — guard against the
          // "wrong app squatting our port" hazard. With container-per-app
          // this is extremely unlikely (one container, one app), but
          // keeping the check costs nothing and catches misconfig.
          try {
            const j = JSON.parse(body);
            if (j.appId && j.appId !== appId) {
              throw new Error(`identity mismatch — health endpoint claims appId=${j.appId} but spawned for ${appId}`);
            }
          } catch (e) {
            if ((e as Error).message?.startsWith('identity mismatch')) throw e;
            // non-JSON body, ignore identity check
          }
          return;
        }
      } catch (e) {
        // Network refused / not ready yet — retry until deadline.
        void e;
      }
      await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
    }
    throw new Error(`container ${instanceId} did not become healthy within ${HEALTH_CHECK_TIMEOUT_MS}ms (lastBody=${lastBody?.slice(0, 200)})`);
  }

  // ─── Lifecycle hooks (identical shape to ProotRunner) ─────────────────
  async callLifecycle(instanceId: string, hook: string): Promise<void> {
    const tracked = this.containers.get(instanceId);
    if (!tracked) return;
    const url = `http://${tracked.hostname}:${tracked.port}${lifecyclePath(tracked.manifest, instanceId, hook)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), LIFECYCLE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'POST', signal: ctrl.signal });
      if (!res.ok) throw new Error(`${hook} → HTTP ${res.status}`);
    } finally { clearTimeout(t); }
  }
  async callOptionalLifecycle(instanceId: string, hook: string, body?: unknown): Promise<unknown> {
    const tracked = this.containers.get(instanceId);
    if (!tracked) return null;
    const url = `http://${tracked.hostname}:${tracked.port}${lifecyclePath(tracked.manifest, instanceId, hook)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), LIFECYCLE_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) return null;
      try { return await res.json(); } catch { return null; }
    } catch { return null; }
    finally { clearTimeout(t); }
  }

  // ─── Kill / cleanup ───────────────────────────────────────────────────
  async kill(instanceId: string): Promise<void> {
    const tracked = this.containers.get(instanceId);
    if (!tracked) return;
    tracked.expectingKill = true;
    try { execSync(`docker stop -t 5 ${tracked.containerId}`, { stdio: 'ignore', timeout: 8_000 }); } catch { /* may already be dead */ }
    // Stop this instance's sibling runtime containers too (the app's own
    // onDestroy usually tears them down first; this is belt-and-braces so a
    // failed/slow teardown can't leak them).
    this.reapSiblingsOf(instanceId);
    this.handleExit(instanceId, 0);
  }
  forceKill(instanceId: string): boolean {
    const tracked = this.containers.get(instanceId);
    if (!tracked) return false;
    tracked.expectingKill = true;
    try { execSync(`docker kill ${tracked.containerId}`, { stdio: 'ignore', timeout: 5_000 }); } catch { /* already gone */ }
    // A force-kill runs no lifecycle hooks by design, so the app's own
    // onDestroy -> teardownAll() never fires. Unlike `kill()` there is no
    // graceful teardown to be belt-and-braces for — this IS the only thing
    // reaping the siblings. Without it they survive on `restart:
    // unless-stopped`, and the next start adopts the stale container via the
    // `isRunning` short-circuit in the SDK's `ensure()` instead of rebuilding
    // it, so config changes never reach a long-running sibling.
    this.reapSiblingsOf(instanceId);
    this.handleExit(instanceId, null);
    return true;
  }
  private handleExit(instanceId: string, code: number | null, watchedId?: string): void {
    const tracked = this.containers.get(instanceId);
    if (!tracked) return;
    // Guard against a STALE watcher clobbering a freshly-respawned container.
    // A single-instance app reuses the same instanceId, so a `docker wait`
    // watcher from a previous container (or the adopted one, keyed by name)
    // can fire while a NEW container is already tracked under this id. Only
    // act if the exit belongs to the container we're currently tracking —
    // otherwise a re-spawn's pre-cleanup `docker rm -f <name>` would delete
    // the new container's tracking and the reconciler would mark it "gone".
    if (watchedId && tracked.containerId !== watchedId) return;
    if (tracked.logTail && !tracked.logTail.killed) { try { tracked.logTail.kill(); } catch { /* ignore */ } }
    const cb = tracked.exitCb;
    const wasExpected = tracked.expectingKill;
    this.containers.delete(instanceId);
    // Only notify on UNEXPECTED exits. AppManager.stop() is mid-cleanup
    // and doesn't want a stray "crashed" event flipping the instance to
    // 'error' state — that breaks the subsequent FSM transition to
    // 'destroyed' and returns 500 from /api/instances/X/stop.
    if (cb && !wasExpected) cb(code);
  }

  // ─── Queries ──────────────────────────────────────────────────────────
  getPort(instanceId: string): number | null {
    return this.containers.get(instanceId)?.port ?? null;
  }
  getHost(instanceId: string): string | null {
    return this.containers.get(instanceId)?.hostname ?? null;
  }
  isRunning(instanceId: string): boolean {
    return this.containers.has(instanceId);
  }
  getActivePids(): number[] {
    // Container instances have HOST pids — invisible from inside the shell's
    // PID namespace. Returning them would just confuse the reconciler's
    // orphan reaper (which scans the SHELL's process tree to find unknown
    // PRoot squatters). Pretend container processes don't exist as far as
    // pid-based tracking is concerned; we manage their lifecycle via
    // `docker wait` / `docker kill` instead.
    return [];
  }
  onExit(instanceId: string, cb: (code: number | null) => void): void {
    const tracked = this.containers.get(instanceId);
    if (tracked) tracked.exitCb = cb;
  }

  // ─── One-time setup: ensure the shared docker network exists ──────────
  private ensureNetwork(): void {
    try {
      execSync(`docker network inspect ${SHARED_NETWORK}`, { stdio: 'ignore', timeout: 5_000 });
    } catch {
      try {
        execSync(`docker network create ${SHARED_NETWORK}`, { stdio: 'ignore', timeout: 10_000 });
        console.log(`[ContainerRunner] created shared docker network: ${SHARED_NETWORK}`);
      } catch (err) {
        console.warn(`[ContainerRunner] could not create ${SHARED_NETWORK}: ${(err as Error).message}. Set AURA_DOCKER_NETWORK or create it manually.`);
      }
    }
  }

  // ─── Volume-name resolution ───────────────────────────────────────────
  //
  // Sibling app containers must mount the SAME named volumes the shell uses
  // for /data (app-data) and /workspace/node_modules. Compose names volumes
  // `<project>_<volume>`, and the project name comes from the directory /
  // COMPOSE_PROJECT_NAME — which ContainerRunner can't guess. Hardcoding a
  // prefix is fragile: it only matches when the dir happens to be named a
  // certain way (this exact mismatch — dir `auraos` vs project `aura` — left
  // every spawned app mounting an empty auto-created volume, so nothing but
  // the shell itself worked). Instead, DISCOVER the real names from the
  // shell's own mounts.
  //
  // Precedence per volume:
  //   1. explicit env override (AURA_APP_DATA_VOLUME / AURA_NODE_MODULES_VOLUME)
  //      — for setups where discovery can't work (e.g. a remote daemon).
  //   2. auto-discovered from `docker inspect` of this container's mounts.
  //   3. legacy `aura_*` default — last resort so a discovery failure still
  //      spawns on the historical dev layout.
  private resolveVolumeNames(): void {
    const discovered = this.discoverVolumeNames();
    const pick = (envName: string, dest: string, found: string | undefined, fallback: string): string => {
      const env = process.env[envName];
      if (env) {
        console.log(`[ContainerRunner] ${dest} volume = ${env} (override ${envName})`);
        return env;
      }
      if (found) {
        console.log(`[ContainerRunner] ${dest} volume = ${found} (auto-discovered)`);
        return found;
      }
      console.warn(`[ContainerRunner] ${dest} volume not discoverable; falling back to ${fallback}. Set ${envName} to override.`);
      return fallback;
    };
    this.appDataVolume     = pick('AURA_APP_DATA_VOLUME',     '/data',                   discovered.appData,     'aura_aura-app-data');
    this.nodeModulesVolume = pick('AURA_NODE_MODULES_VOLUME', '/workspace/node_modules', discovered.nodeModules, 'aura_aura-node-modules');
  }

  /**
   * Inspect this (the shell's own) container's mounts and read back the named
   * volumes docker actually attached at /data and /workspace/node_modules.
   * Best-effort: any failure (no socket, unknown id, bind mount without a
   * volume name, JSON error) yields an empty result and the caller falls back.
   */
  private discoverVolumeNames(): { appData?: string; nodeModules?: string } {
    const ref = this.getOwnContainerId();
    if (!ref) return {};
    let mounts: DockerMount[];
    try {
      const out = execSync(`docker inspect -f '{{json .Mounts}}' ${ref}`, {
        stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, encoding: 'utf-8',
      }).trim();
      mounts = JSON.parse(out) as DockerMount[];
    } catch (err) {
      console.warn(`[ContainerRunner] volume auto-discovery failed (inspect ${ref}): ${(err as Error).message}`);
      return {};
    }
    return {
      appData:     pickVolumeByDestination(mounts, '/data'),
      nodeModules: pickVolumeByDestination(mounts, '/workspace/node_modules'),
    };
  }

  /**
   * Resolve the id/name of the container this process runs inside. Primary
   * source is /proc/self/mountinfo — docker bind-mounts /etc/hostname & co.
   * from /var/lib/docker/containers/<id>/…, which is present under both
   * cgroup v1 and v2. Falls back to the shell's known name/hostname (equal to
   * `container_name` in the compose file, which `docker inspect` also accepts).
   */
  private getOwnContainerId(): string | null {
    try {
      const id = readFileSync('/proc/self/mountinfo', 'utf-8').match(/\/containers\/([0-9a-f]{64})\//)?.[1];
      if (id) return id;
    } catch { /* not in a container / no procfs */ }
    return this.shellHostname || hostname() || null;
  }
}
