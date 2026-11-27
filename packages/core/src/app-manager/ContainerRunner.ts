import { spawn, spawnSync, execSync, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { AppManifest } from '../types/manifest.js';
import { lifecyclePath } from '../types/manifest.js';
import { MY_TOOLS_PATH, currentToolsMode, provisionAllowlist, toolchainMirrorBin } from './tool-provision.js';
import { containerHomeEnv, containerHomeMount } from './spawn/homeArgs.js';
import { containerContextEnv, containerContextMounts } from './spawn/contextArgs.js';
import { containerNetworkArgs, containerNetworkEnv, containerShellBase, rawSocketArgs, terminalNetworkUser } from './spawn/networkArgs.js';
import { TERM_NETWORK_CONTAINER_LABEL, TermNetworks, type TermNetwork } from '../runtimes/container/networks.js';
import { containerIdentityArgs, isNonRootIdentity, writeIdentityFiles } from './spawn/identityArgs.js';
import {
  SESSION_IDENTITY_LABEL, readKernelSessionSecret, sessionHostUser, sessionServerOwner, terminalSessionArgs, terminalSessionCommand, writeSessionSecret,
} from './spawn/sessionArgs.js';
import { containerName } from '../runtimes/container/names.js';
import type { RuntimeCapabilities } from '../runtimes/types.js';
import type { ForwarderFacts } from '../runtimes/container/endpoints.js';
import type { RuntimeLogsRequest, RuntimeLogsStream, RuntimeOutputStream, RuntimeWorkloadExec } from '../runtimes/ari.js';
import { IDMAP_HELPER_PATH, type ContainerMountBackend, type ContainerPortBackend, type ContainerSidecarBackend, type FacilityProbe, type SidecarRuntimeFacts } from '../runtimes/container/backends.js';
// Value import, but MountManager imports ContainerRunner type-only, so there
// is no runtime cycle.
import { MOUNT_ROOT_PATH } from './MountManager.js';
import { KEEP_RESTART_LABEL, keptAcrossRestart, type KeepSiblings } from './sidecarParking.js';
import type { SandboxExecOpts, SandboxRunner, SandboxRunnerOpts } from './SandboxRunner.js';
import type { ExecSession, SessionSpec } from './ExecBridge.js';
import { ExecBridgeError } from './ExecBridge.js';
import { DockerApi, engineExec, engineLogs, type EngineClient } from './DockerApi.js';
import { SessionBroker, stageSessionEnter } from './SessionBroker.js';
import type { ResourceUsage, SidecarInfo } from '../types/instance.js';
import { SIDECAR_PS_FORMAT, USAGE_STATS_FORMAT, parseSidecarPs, parseUsageStats } from './sidecars.js';
import type { InstanceSpawnContext } from './SandboxRunner.js';
import { OWNER_LABEL, PREVIEW_LABEL } from './instanceOwner.js';
import { VolumeStore, type VolumeEntry } from '../context/VolumeStore.js';
import {
  ASTRO_START_SHELL, RAW_START_SHELL, PROVISION_TIMEOUT_MS, ProvisionWatch, nextHealthDeadline,
  BUILDER_CACHE_PATH, BUILDER_CACHE_SUBPATH, builderProvisionEnv, builderProvisionShell, provisionBuilderTools,
} from './provisioning.js';
import { BUILD_STAGING_DIR, serveState } from './appBuild.js';
import { BASE_IMAGE, whenBaseImageReady } from './BaseImage.js';
import {
  checkHealthGuard, classifyHealthIdentity, healthIdentityRefusal, lifecycleHeaders, lifecycleStatusRefusal,
  newLifecycleToken, relayStrictEnv, type HealthIdentityClass, type LifecycleStatus,
} from './lifecycleGate.js';
import { relayKey } from '../app-hosts/relayClaim.js';

const HEALTH_CHECK_INTERVAL_MS = 200;
const HEALTH_CHECK_TIMEOUT_MS = 60_000; // slightly higher than PRoot because container spawn adds ~100 ms
const LIFECYCLE_TIMEOUT_MS = 5_000;
const SHARED_NETWORK = process.env['AURA_DOCKER_NETWORK'] ?? 'aura-net';

const execFileAsync = promisify(execFile);

/**
 * The app container's env keys a session inherits (J.2: the app's spawn env
 * minus anything secret). An allowlist: Context keys, the instance token and
 * the lifecycle token never reach a session.
 */
export const SESSION_APP_ENV: ReadonlySet<string> = new Set([
  'APP_ID', 'APP_INSTANCE_ID', 'APP_PORT', 'OS_API_BASE', 'AURA_LAYER_TAG', 'AURA_SERVE', 'AURA_HOSTNAME',
  'AURA_SHELL_HOSTNAME', 'AURA_TOOLS_MODE', 'AURA_MOUNT_ROOT', 'AURA_RUN_AS', 'ASTRO_TELEMETRY_DISABLED',
  'NODE_ENV', 'NODE_VERSION', 'YARN_VERSION', 'PATH', 'TERM', 'COLORTERM', 'LANG', 'LC_ALL',
]);

/**
 * The long-running `docker logs -f` / `docker wait` watchers: two per app
 * container, all children of the shell, all inside the shell container's
 * pids cgroup (~1035 on a typical install) next to the shell itself. Each
 * `docker` CLI is a Go program whose runtime starts a thread per CPU; these
 * only wait on one stream, so one is plenty — about half the pids.
 */
const WATCHER_ENV = { ...process.env, GOMAXPROCS: '1' };
const WATCHER_RETRY_MAX_MS = 30_000;
type WatcherStdio = ['ignore', 'pipe', 'pipe' | 'ignore'];

/**
 * Spawn a docker watcher. A spawn that fails (EAGAIN — out of pids — EMFILE,
 * ENOMEM) is retried with backoff for as long as `stillWanted()`; it must
 * never become an uncaught 'error' that takes the shell down (seen on boot,
 * re-adopting ~45 containers at once), nor be mistaken for the container
 * having exited. `wire` attaches the stream handlers to every attempt;
 * `onError` sees errors of a watcher that did start.
 */
function spawnDockerWatcher(
  args: string[],
  stdio: WatcherStdio,
  label: string,
  wire: (child: ChildProcess) => void,
  stillWanted: () => boolean,
  onError?: (err: Error) => void,
  attempt = 0,
): ChildProcess {
  const child = spawn('docker', args, { stdio, env: WATCHER_ENV });
  let started = false;
  child.once('spawn', () => { started = true; });
  child.on('error', (err: NodeJS.ErrnoException) => {
    if (started) { onError?.(err); return; }
    const delay = Math.min(WATCHER_RETRY_MAX_MS, 1000 * 2 ** attempt);
    console.warn(`[ContainerRunner] ${label}: spawn docker ${args[0]} failed (${err.code ?? err.message}), retry in ${delay} ms`);
    setTimeout(() => {
      if (stillWanted()) spawnDockerWatcher(args, stdio, label, wire, stillWanted, onError, attempt + 1);
    }, delay);
  });
  wire(child);
  return child;
}

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

// The synthesised start command (astro dev, or the production build when it
// matches the sources) is shared with ProotRunner: provisioning.ts
// ASTRO_START_SHELL, chosen per start via AURA_SERVE (appBuild.ts serveState).
const SYNTHESISED_ENTRYPOINT = ASTRO_START_SHELL;

/** Workspace root files an app container and an app build mount read-only (workspaceMounts). */
export const WORKSPACE_ROOT_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json'] as const;

/** What `docker inspect` says about a container name; null when no such container. */
export interface ContainerNameState { id: string; status: string }

export interface ClearContainerNameDeps {
  inspect: (name: string) => Promise<ContainerNameState | null>;
  remove: (ref: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  /** True when `id` is the container a live instance is using right now. */
  isLive: (id: string) => boolean;
  /** True while the survivors of a shell restart are unknown (the adoption scan failed): a running container is kept. */
  survivorsUnknown?: () => boolean;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Make sure no container holds `name` before `docker run --name <name>`.
 *
 * App containers run with `--rm`, so after `docker stop` returns the daemon
 * removes the container asynchronously. A `docker rm -f` in that window fails
 * with "removal … already in progress" and returns at once, and an immediate
 * `docker run` then hits "Conflict. The container name … is already in use".
 * So: wait while the container is `removing`, force-remove any other leftover
 * (exited, created, dead, or an untracked orphan), and re-check until the name
 * is free. A container a live instance is still using is never removed, nor
 * is a running one while the survivors of a shell restart are still unknown
 * (`survivorsUnknown`: the adoption scan failed): it may be a survivor the
 * owner is working in (M6), and the spawn fails instead.
 */
export async function clearContainerName(name: string, deps: ClearContainerNameDeps): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const pollMs = deps.pollMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  let last = 'unknown';
  for (;;) {
    const st = await deps.inspect(name);
    if (!st) return;
    last = st.status;
    if (deps.isLive(st.id)) {
      throw new Error(`container name ${name} is in use by live container ${st.id.slice(0, 12)} (${st.status})`);
    }
    if (st.status === 'running' && deps.survivorsUnknown?.()) {
      throw new Error(`container name ${name} is held by running container ${st.id.slice(0, 12)}, which may survive from before the shell restart; not removed until adoption succeeds`);
    }
    if (st.status !== 'removing') {
      try { await deps.remove(st.id); } catch { /* removal may already be under way; re-check below */ }
    }
    if (Date.now() >= deadline) break;
    await deps.sleep(pollMs);
  }
  throw new Error(`container name ${name} still taken after ${timeoutMs} ms (state=${last})`);
}

async function dockerInspectState(name: string): Promise<ContainerNameState | null> {
  try {
    const { stdout } = await execFileAsync('docker', ['inspect', '-f', '{{.Id}} {{.State.Status}}', name], { timeout: 5_000 });
    const [id, status] = stdout.trim().split(/\s+/);
    return id ? { id, status: status ?? 'unknown' } : null;
  } catch (err) {
    if (/no such (object|container)/i.test(String((err as { stderr?: string }).stderr ?? (err as Error).message))) return null;
    throw err;
  }
}

/**
 * The pid and addresses of the container `docker run` just created, by its id
 * (never by name). `address` is its address on `network` (the shared one, or
 * a Terminal's private one: where the shell dials it); null when docker
 * reports none — the caller then can't bind lifecycle calls to it.
 * `addresses` are its addresses on every network (network identity, D28).
 */
export function inspectSpawned(
  containerId: string, run: (args: string[]) => string = dockerOut, network: string = SHARED_NETWORK,
): { pid: number; address: string | null; addresses: string[] } {
  try {
    const out = run(['inspect', '-f', '{{.State.Pid}} {{json .NetworkSettings.Networks}}', containerId]).trim();
    const space = out.indexOf(' ');
    const pid = parseInt(out.slice(0, space), 10) || 0;
    const networks = JSON.parse(out.slice(space + 1)) as DockerNetworks | null;
    return { pid, address: networks?.[network]?.IPAddress || null, addresses: networkAddresses(networks) };
  } catch {
    return { pid: 0, address: null, addresses: [] };
  }
}

type DockerNetworks = Record<string, { IPAddress?: string; GlobalIPv6Address?: string }>;

/** Every address a container has, over all its networks. */
function networkAddresses(networks: DockerNetworks | null | undefined): string[] {
  return Object.values(networks ?? {}).flatMap((n) => [n?.IPAddress, n?.GlobalIPv6Address]).filter((a): a is string => !!a);
}

function dockerOut(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** `http://<address>:<port>/api/lifecycle/<hook>`; an IPv6 address gets brackets. */
function lifecycleUrl(address: string, port: number, hook: string): string {
  return `http://${address.includes(':') ? `[${address}]` : address}:${port}${lifecyclePath(hook)}`;
}

/** A session host's own user, from its label (stream T2): the session launcher's target check. */
function sessionHostTarget(label: string | undefined): { sessionHostUid?: number } {
  const uid = Number(/^(\d+):\d+$/.exec(label ?? '')?.[1] ?? 0);
  return uid > 0 ? { sessionHostUid: uid } : {};
}

interface TrackedContainer {
  /** Watches the app's log to tell "installing dependencies" from "failing
   *  to boot", so the health deadline can stay open for the former. */
  provision: ProvisionWatch;
  /** docker container ID (long form). */
  containerId: string;
  /** Hostname siblings reach this container by — `aura-<sanitized-instanceId>`. */
  hostname: string;
  /**
   * The container's own address on the shared network, read from `docker
   * inspect` of the container id `docker run` returned. Lifecycle calls go
   * here, never to the DNS name: anyone who can create a container can add a
   * network alias `aura-<id>`, and a stale container can hold the name.
   * Null only for an adopted container whose address couldn't be read; it
   * then gets lifecycle calls by name and without the token.
   */
  address: string | null;
  /**
   * The shell dials `address`, not the name: a Terminal on its private
   * network (D58), whose name also resolves to its shared-network address,
   * where nothing of its own listens.
   */
  dialByAddress: boolean;
  /** Its addresses on every network it is on (network identity, D28). */
  addresses: string[];
  /** This start's lifecycle secret (`AURA_LIFECYCLE_TOKEN` in the container's env). */
  lifecycleToken?: string;
  /** A session host's session uid:gid (stream T2): `docker exec` runs as it, never as the container's root launcher. */
  sessionUser?: string;
  /** Health identity and runtime-check result, once healthy (not for adopted containers). */
  lifecycle?: LifecycleStatus;
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
export class ContainerRunner implements SandboxRunner, ContainerMountBackend, ContainerPortBackend, ContainerSidecarBackend {
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
  /** OS-managed shared volumes, mounted into every container. */
  private volumeStore: VolumeStore;
  /** The per-user private Terminal networks (D58). */
  private termNetworks: TermNetworks;

  /**
   * Whether the survivors of the last shell lifetime are still unknown: the
   * AppManager's adoption scan failed and its reconciler retries it. Set by
   * the AppManager; spawns then never remove a running container by name (M6).
   */
  public survivorsUnknown: () => boolean = () => false;

  constructor(opts: SandboxRunnerOpts) {
    this.toolchainDir = opts.toolchainDir;
    this.appsDir      = opts.appsDir;
    this.dataDir      = opts.dataDir;
    this.osApiBase    = opts.osApiBase;
    this.volumeStore  = new VolumeStore(opts.dataDir);
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
    this.termNetworks = new TermNetworks(() => this.getOwnContainerId());
    // Before adoption: a surviving Terminal is reachable only there.
    this.termNetworks.joinExisting();
  }

  /**
   * Today's container runtime (ARI §2.3): namespaces, enforced read-only
   * binds, mounts, port expose, sidecars, re-adoption. It enforces an app
   * identity (`--user`, no capabilities, no-new-privileges: stream A,
   * `identity: enforced`). Sessions enter the running container through the
   * session broker (stream J, D74: `openSession`), with the Private Home
   * bound in the session's own mount namespace only (`privateHomeSession`).
   * Whether a given instance may get a private session also depends on its
   * installation running non-root (J.5): the kernel checks that per instance.
   */
  public capabilities(): RuntimeCapabilities {
    return {
      isolation: 'namespace',
      network: 'bridge',
      appHome: true,
      privateHomeSession: true,
      sessionExec: true,
      identity: 'enforced',
      readOnlyBinds: true,
      hostFilesystem: true,
      mounts: true,
      // D80: an idmapped bind passed the boot probe (`probeIdmappedMounts`); false until then, and
      // where it fails: a cross-uid writable mount is then refused, never downgraded.
      idmappedMounts: this.idmapProbe?.ok === true,
      portExpose: true,
      sidecars: true,
      warmPool: true,
      survivesShellRestart: true,
      usage: true,
      gpu: false,
    };
  }

  // ─── Tool-allowlist dir (shared semantics with PRoot) ─────────────────
  public toolsDir(instanceId: string): string {
    return join(this.dataDir, 'aura', 'runtime', instanceId, 'tools');
  }
  public provisionToolsDir(instanceId: string, manifest: Pick<AppManifest, 'tools'>): string {
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

  /**
   * What SidecarManager needs to start a container the way this runner starts
   * app containers: the shared volumes, network and OS coordinates.
   */
  public sidecarRuntime(): SidecarRuntimeFacts {
    return {
      dataDir: this.dataDir,
      appDataVolume: this.appDataVolume,
      nodeModulesVolume: this.nodeModulesVolume,
      network: SHARED_NETWORK,
      osApiBase: this.osApiBase,
      shellHostname: this.shellHostname,
      workspaceRoot: this.workspaceRoot,
      toolsMode: currentToolsMode(this.dataDir),
    };
  }

  // ─── Spawn ────────────────────────────────────────────────────────────
  async spawn(instanceId: string, appId: string, port: number, manifest: AppManifest, ctx: InstanceSpawnContext): Promise<number> {
    // On a first boot without the base image the shell builds it in the
    // background; the spawn waits for it instead of failing on a docker pull.
    await whenBaseImageReady();
    this.provisionToolsDir(instanceId, manifest);

    const hostname = this.containerName(instanceId);
    // The name must be free before `docker run`: a leftover from a crashed
    // shell, or — on a restart — the previous container that `--rm` is still
    // removing after kill()'s `docker stop` returned.
    await clearContainerName(hostname, {
      inspect: dockerInspectState,
      remove: async (ref) => { await execFileAsync('docker', ['rm', '-f', ref], { timeout: 10_000 }); },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      isLive: (id) => this.containers.get(instanceId)?.containerId === id,
      survivorsUnknown: () => this.survivorsUnknown(),
    });

    // OS-managed shared volumes — resolved live too, and ensureAll guarantees
    // each volume's subpath dir exists before docker mounts it.
    await this.volumeStore.ensureAll();
    const contextVolumes = await this.volumeStore.resolveMounts();

    // A System Terminal's private network (D58), with the shell on it. A
    // failure fails the spawn: never a Terminal listening on the shared network.
    const termUser = terminalNetworkUser(appId, ctx);
    const term = termUser ? this.termNetworks.ensure(termUser) : null;

    // A non-root app (stream A): its passwd and group, mounted read-only.
    if (isNonRootIdentity(ctx.identity)) writeIdentityFiles(this.dataDir, instanceId, ctx.identity, ctx.installationId ?? null);
    const args = this.buildDockerArgs(instanceId, appId, port, manifest, hostname, ctx, contextVolumes, term);
    console.log(`[ContainerRunner] Spawning ${hostname} (app=${appId}) on port ${port}`);

    // Use spawnSync (not execSync with a joined string) so multi-word args
    // like `bash -c '<SYNTHESISED_ENTRYPOINT>'` don't get re-split by the
    // shell — every entry in `args` ends up as a separate argv slot. The
    // lifecycle token reaches the container through the client's env
    // (`-e AURA_LIFECYCLE_TOKEN` without a value), not its command line.
    const lifecycleToken = newLifecycleToken();
    // A session host's server takes its token from a one-time file, not its env (stream T).
    if (sessionHostUser(appId, ctx)) writeSessionSecret(this.dataDir, instanceId, lifecycleToken, sessionServerOwner(ctx.identity));
    const r = spawnSync('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, encoding: 'utf-8',
      env: { ...process.env, AURA_LIFECYCLE_TOKEN: lifecycleToken },
    });
    if (r.status !== 0) {
      throw new Error(`docker run failed for ${instanceId} (status=${r.status}): ${r.stderr?.trim() || r.error?.message || 'no stderr'}`);
    }
    const containerId = (r.stdout ?? '').trim();
    if (!containerId) throw new Error(`docker run for ${instanceId} returned no container id`);

    // Fan-out container stdout/stderr into the shell's log so `docker logs`
    // isn't the only place to see app output. Survives until the container
    // exits or we kill it.
    const provision = new ProvisionWatch();
    const stillTracked = () => this.containers.get(instanceId)?.containerId === containerId;
    const logTail = spawnDockerWatcher(['logs', '-f', containerId], ['ignore', 'pipe', 'pipe'], `${instanceId} logs`, (c) => {
      c.stdout?.on('data', (d: Buffer) => {
        provision.observe(d.toString());
        process.stdout.write(`[${instanceId}] ${d}`);
      });
      c.stderr?.on('data', (d: Buffer) => {
        provision.observe(d.toString());
        process.stderr.write(`[${instanceId}] ${d}`);
      });
      const t = this.containers.get(instanceId);
      if (t && t.containerId === containerId) t.logTail = c;   // a retried tail replaces the failed one
    }, stillTracked);

    // `docker inspect` of the id we just created: the pid (orphan-reaper
    // accounting) and the address the lifecycle calls are bound to. No
    // address on the shared network = the destination can't be bound to this
    // container, so the token is never sent and the start fails.
    const dialNetwork = term?.name ?? SHARED_NETWORK;
    const { pid, address, addresses } = inspectSpawned(containerId, dockerOut, dialNetwork);

    const tracked: TrackedContainer = {
      containerId, hostname, address, dialByAddress: !!term, addresses, lifecycleToken, port, appId, logTail, pid,
      exitCb: null, expectingKill: false, provision,
      ...(sessionHostUser(appId, ctx) && ctx.identity?.uid ? { sessionUser: `${ctx.identity.uid}:${ctx.identity.gid}` } : {}),
    };
    this.containers.set(instanceId, tracked);

    // Watch for container exit so we can fire the exit callback.
    spawnDockerWatcher(['wait', containerId], ['ignore', 'pipe', 'ignore'], `${instanceId} wait`, (c) => {
      c.stdout?.on('data', (d: Buffer) => {
        const code = parseInt(d.toString().trim(), 10);
        this.handleExit(instanceId, isNaN(code) ? null : code, containerId);
      });
    }, stillTracked, () => this.handleExit(instanceId, null, containerId));

    try {
      if (!address) throw new Error(`cannot bind ${instanceId} to container ${containerId.slice(0, 12)}: no address on ${dialNetwork}; lifecycle token not sent`);
      const identity = await this.waitHealthy(instanceId, appId, containerId, port);
      const lifecycle: LifecycleStatus = { identity, guard: await checkHealthGuard(lifecycleUrl(address, port, 'health')) };
      const refusal = lifecycleStatusRefusal(instanceId, lifecycle);
      if (refusal) throw new Error(refusal);
      tracked.lifecycle = lifecycle;
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
  private propagationCache: FacilityProbe | null = null;
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

  /** The last idmapped-bind probe (D80), the helper it ran as a daemon host path; null before it ran. */
  private idmapProbe: FacilityProbe | null = null;
  private idmapHelper: string | null = null;

  /** D80: whether an idmapped bind works on the data filesystem (`ok: false` until probed). */
  public canIdmapMounts(): FacilityProbe {
    return this.idmapProbe ?? { ok: false, reason: 'not probed yet' };
  }

  /** The idmap helper (the staged session launcher) as a daemon host path, once the probe passed. */
  public idmapHelperHostPath(): string | null {
    return this.idmapProbe?.ok ? this.idmapHelper : null;
  }

  /**
   * D80: probes an idmapped bind of a scratch dir on the data filesystem, in
   * the privileged mount helper with the session launcher's `idmap-probe`
   * (it attaches nothing). Run at boot (AppManager init). Any failure (no
   * kernel support, a filesystem that refuses it, a launcher that predates
   * the subcommand, no engine, no base image yet) makes `idmappedMounts`
   * false: cross-uid writable mounts are then refused with that reason. Only
   * the composition point asks for it (AppManager `probeIdmappedMounts`):
   * tests never run a privileged helper.
   */
  public async probeIdmappedMounts(run: (args: string[]) => Promise<unknown> = (args) => execFileAsync('docker', args, { timeout: 60_000 })): Promise<FacilityProbe> {
    let result: FacilityProbe;
    try {
      // No base-image wait: a probe must never start an image build. Missing, it fails (false until the next boot).
      const helper = this.toDaemonHostPath(await stageSessionEnter(this.dataDir));
      const scratch = join(this.dataDir, 'aura', 'runtime', 'idmap-probe');
      mkdirSync(scratch, { recursive: true, mode: 0o700 });
      await run(idmapProbeArgs({ helper, scratch: this.toDaemonHostPath(scratch), image: BASE_IMAGE }));
      this.idmapHelper = helper;
      result = { ok: true };
    } catch (err) {
      const e = err as { stderr?: string | Buffer; message?: string };
      const detail = String(e.stderr ?? '').trim().split('\n').pop() || e.message || String(err);
      result = { ok: false, reason: `idmapped mounts unavailable: ${detail}` };
      console.warn(`[ContainerRunner] ${result.reason}`);
    }
    this.idmapProbe = result;
    return result;
  }

  /** Build the `docker run` argv mirroring ProotRunner's bind topology. */
  private buildDockerArgs(
    instanceId: string,
    appId: string,
    port: number,
    manifest: AppManifest,
    hostname: string,
    ctx: InstanceSpawnContext,
    contextVolumes: VolumeEntry[],
    term: TermNetwork | null = null,
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
    // The APP-level dir (one segment up from the instance dir), exported below
    // so the app — and @aura/app-sdk's sidecar host — can address it as a
    // volume-subpath. Sidecar state belongs beside the app's own data rather
    // than in a dedicated docker volume nothing else can see; app-level, not
    // instance-level, because a sidecar is per-app (it doesn't multiply with
    // instances).
    const appDataSubpath = dataSubpath.split('/').slice(0, -1).join('/');

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
    const appDirMount = this.buildAppDirMount(ctx.appDir, appId, appDataVolume, undefined, ownSourceReadOnly(ctx, manifest));
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
      // docker-init (tini) as PID 1 reaps orphans. Without it the app's own
      // process is PID 1, and app servers (node, python) never reap: every
      // backgrounded child that outlives its parent stays a zombie until the
      // container's pid limit is hit and fork() fails for everything.
      '--init',
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
      ...containerNetworkArgs({ network: SHARED_NETWORK, term }),
      // No raw sockets: its address can't be forged on a shell network (D28, D88 S1).
      ...rawSocketArgs(),
      // Lets InstanceTokens re-learn the nonce of a container adopted after a
      // shell restart. Not `aura.parent`: that label marks sidecars, which
      // orphan adoption must skip.
      ...(ctx.instanceToken ? ['--label', `aura.token.nonce=${ctx.instanceToken.nonce}`] : []),
      ...(ctx.owner ? ['--label', `${OWNER_LABEL}=${ctx.owner}`] : []),
      // A preview (Track P) is known again after a shell restart, and reaped.
      ...(ctx.preview ? ['--label', `${PREVIEW_LABEL}=${ctx.preview}`] : []),
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
      ...this.workspaceMounts(),
      // The capability registry. Without it the sandboxed `aura cap …` seeds
      // a PRIVATE copy from the CLI bundle's built-in defaults and never sees
      // entries added to the real file afterwards — `aura cap list` in a
      // terminal then silently disagrees with the same command on the master.
      // Read-only on purpose: the master owns registry edits (`cap registry
      // add`), and a sandbox attempt should fail loudly, not fork the file.
      '-v', `${this.workspaceRoot}/.aura:/workspace/.aura:ro`,
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
      // The App Home the kernel resolved (spawn/homeArgs.ts, D65): never the
      // user's Private Home. The resolver created the dir, so docker can mount
      // the subpath at container start; without one the spawn is refused.
      ...containerHomeMount({ appDataVolume, home: ctx.home }),
      // The shared Context Volumes (spawn/contextArgs.ts). No /run/context (stream C).
      ...containerContextMounts({ appDataVolume, volumes: contextVolumes }),
      // No Docker socket, ever (stream J.7, spawn/socketArgs.ts): only a root tab's session has it.
      // The Context keys the kernel granted this start (declared AND granted,
      // stream C) FIRST — the fixed OS vars below are pushed after, so a
      // context key can't clobber them (docker's last-wins semantics).
      ...containerContextEnv(ctx.contextEnv),
    ];

    a.push(
      '-e', `APP_ID=${appId}`,
      '-e', `APP_INSTANCE_ID=${instanceId}`,
      '-e', `APP_PORT=${port}`,
      // A Terminal reaches the shell over its private network (spawn/networkArgs.ts, D89 B8).
      '-e', `OS_API_BASE=${containerShellBase({ osApiBase: this.osApiBase, term, shellHostname: this.shellHostname })}`,
      '-e', `AURA_LAYER_TAG=[ctnr]`,
      // prod = start from the app's build (it matches the sources), dev =
      // astro dev. Read by ASTRO_START_SHELL; also tells an adopted container
      // apart. Apps with their own entrypoint ignore it.
      '-e', `AURA_SERVE=${serveState(ctx.appDir, manifest).mode}`,
      // Hostname override read by bashrc.aura.sh's PS1. We also set the
      // kernel hostname via --hostname above, but a process can sethostname()
      // away from that; the env stays put across `docker exec` invocations
      // too, so `aura jump` shells reliably show the right name.
      '-e', `AURA_HOSTNAME=${appId}`,
      // Forward the master host name so the Terminal app's base shell can show
      // the host ("aura-shell") in its session-host indicator rather than its
      // own `--hostname <appId>` kernel name. Read by pty-server / index.astro.
      '-e', `AURA_SHELL_HOSTNAME=${this.shellHostname}`,
      // Where this app's data lives inside the shared app-data volume. The SDK
      // needs BOTH halves to mount a sidecar's state next to it
      // (`<subpath>/.sidecars/<service>/<volume>`): the volume name varies with
      // the compose project prefix, and the subpath varies with the app's
      // scope, so neither can be derived inside the container.
      '-e', `AURA_APP_DATA_VOLUME=${appDataVolume}`,
      '-e', `AURA_APP_DATA_SUBPATH=${appDataSubpath}`,
      // HOME on the persistent volume (the App Home), so tools keep their
      // state across container respawns (spawn/homeArgs.ts).
      ...containerHomeEnv(),
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
      // No LD_LIBRARY_PATH: granted tools with staged libraries are wrapper
      // scripts that scope it to their own process tree (provisionAllowlist).
      // Exporting it container-wide made the staged Debian sonames shadow the
      // image's own newer copies — any runtime linked against a newer
      // libcrypto/libssl than the shell's broke at import time.
      // Which allowlist mode the OS provisioned this instance with. Read by
      // @aura/app-sdk's sidecar host (`inheritTools`) so a sibling runtime
      // mounts the same set the OS gave the controlling app — and, in
      // hardlink mode, skips the shared /aura/all-tools mount instead of
      // silently re-opening the whole toolchain to the sibling.
      '-e', `AURA_TOOLS_MODE=${toolsMode}`,
      // Where cross-app mounts appear, so apps and the CLI can find them
      // without hardcoding a path the OS may move.
      '-e', `AURA_MOUNT_ROOT=${MOUNT_ROOT_PATH}`,
      // Bearer for the token-gated OS routes (sidecars). After contextEnv so a
      // context key of the same name can't replace it.
      ...(ctx.instanceToken ? ['-e', `AURA_INSTANCE_TOKEN=${ctx.instanceToken.token}`] : []),
      // Per-start shell→app lifecycle secret (lifecycleGate.ts). Name only:
      // docker takes the value from spawn()'s env, so it stays off the
      // command line. After contextEnv, like the instance token.
      // A session host takes it from a one-time file instead (spawn/sessionArgs.ts): never in its env.
      ...(sessionHostUser(appId, ctx) ? [] : ['-e', 'AURA_LIFECYCLE_TOKEN']),
      // D89 B4: a strict relay mode (app-sdk shell-peer); nothing in the default `warn`.
      ...Object.entries(relayStrictEnv()).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      // A Terminal's private listen subnet and shell peer (spawn/networkArgs.ts, D58).
      ...containerNetworkEnv({ term, shellHostname: this.shellHostname }),
      // The process identity (spawn/identityArgs.ts): root, or the installation's app uid (P5-3).
      ...containerIdentityArgs(ctx.identity, { appDataVolume, instanceId }),
      // A System Terminal is its user's session host (spawn/sessionArgs.ts, stream T, D69).
      ...terminalSessionArgs(appId, ctx, { appDataVolume, instanceId }),
      BASE_IMAGE,
    );
    // A session host's command runs under its session launcher (spawn/sessionArgs.ts, stream T2).
    a.push(...terminalSessionCommand(appId, ctx, entrypoint));
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
      // Provision first (npm tree, @aura/* packages), then the app's own entrypoint.
      return ['bash', '-c', RAW_START_SHELL, 'aura-raw', `/workspace/apps/${appId}/${manifest.entrypoint}`];
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
  private buildAppDirMount(
    ctxAppDir: string, appId: string, appDataVolume: string, target = `/workspace/apps/${appId}`, ro = false,
  ): string[] {
    if (ctxAppDir.startsWith('/workspace/')) {
      // toHostPath rewrites the /workspace prefix to AURA_HOST_WORKSPACE so the
      // bind source resolves on the HOST daemon (no-op on Linux, required for
      // Mac VM-based daemons).
      const hostPath = this.toHostPath(ctxAppDir);
      return ['-v', `${hostPath}:${target}${ro ? ':ro' : ''}`];
    }
    if (ctxAppDir.startsWith(`${this.dataDir}/`) || ctxAppDir.startsWith('/data/')) {
      // Strip the dataDir prefix to get the volume-internal path.
      const prefix = ctxAppDir.startsWith(this.dataDir + '/') ? this.dataDir : '/data';
      const subpath = ctxAppDir.slice(prefix.length).replace(/^\/+/, '');
      return ['--mount', `type=volume,source=${appDataVolume},target=${target},volume-subpath=${subpath}${ro ? ',readonly' : ''}`];
    }
    // Unrecognised prefix — fall back to the plain bind and log. Most likely
    // a misconfigured scope; the bind will probably fail at container start.
    console.warn(`[ContainerRunner] unrecognised appDir prefix for ${appId}: ${ctxAppDir} — falling back to plain bind`);
    return ['-v', `${ctxAppDir}:${target}${ro ? ':ro' : ''}`];
  }

  private containerName(instanceId: string): string {
    return containerName(instanceId);
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
  /** Remove the containers with `labelKey=labelVal`. With `keep` (a restart
   *  stop), the ones that opted in are left running; returns how many. */
  private reapSiblings(labelKey: 'aura.parent' | 'aura.app', labelVal: string, keep?: KeepSiblings): number {
    let ids: string[] = [];
    let kept = 0;
    try {
      const out = execSync(`docker ps -a --filter "label=${labelKey}=${labelVal}" --format '{{.ID}}\t{{.Names}}\t{{.Label "${KEEP_RESTART_LABEL}"}}\t{{.Label "aura.service"}}'`, {
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, encoding: 'utf-8',
      });
      for (const line of out.split('\n')) {
        const [id, name, keepLabel, service] = line.trim().split('\t');
        if (!id) continue;
        if (keep && keptAcrossRestart(keepLabel, service, keep)) {
          kept++;
          console.log(`[ContainerRunner] parked sibling ${name ?? id} (${labelKey}=${labelVal}, survives the restart)`);
          continue;
        }
        ids.push(id);
      }
    } catch (err) {
      console.warn(`[ContainerRunner] reapSiblings ${labelKey}=${labelVal}: docker ps failed: ${(err as Error).message}`);
      return 0;
    }
    for (const id of ids) {
      try {
        execSync(`docker rm -f ${id}`, { stdio: 'ignore', timeout: 10_000 });
        console.log(`[ContainerRunner] reaped sibling ${id} (${labelKey}=${labelVal})`);
      } catch { /* already gone */ }
    }
    return kept;
  }

  /** Remove sibling containers belonging to a specific instance. Public so
   *  AppManager can reap on graceful stop AND unexpected-exit (crash). */
  public reapSiblingsOf(instanceId: string, opts: { keep?: KeepSiblings } = {}): number {
    return this.reapSiblings('aura.parent', instanceId, opts.keep);
  }

  // ─── Sidecars (OS abstraction; container encoding in ./sidecars.ts) ───
  async listSidecars(): Promise<SidecarInfo[] | null> {
    try {
      const { stdout } = await execFileAsync(
        'docker', ['ps', '-a', '--filter', 'label=aura.parent', '--format', SIDECAR_PS_FORMAT],
        { timeout: 10_000, encoding: 'utf-8' },
      );
      return parseSidecarPs(stdout);
    } catch (err) {
      console.warn(`[ContainerRunner] listSidecars: docker ps failed: ${(err as Error).message}`);
      return null;
    }
  }

  removeSidecars(ids: string[]): void {
    for (const id of ids) {
      try {
        execSync(`docker rm -f ${JSON.stringify(id)}`, { stdio: 'ignore', timeout: 10_000 });
        console.log(`[ContainerRunner] reaped orphan sidecar ${id}`);
      } catch { /* already gone */ }
    }
  }

  async usage(req: { instanceIds: string[]; sidecarIds: string[] }): Promise<Map<string, ResourceUsage>> {
    const nameToKey = new Map<string, string>();
    for (const id of req.instanceIds) {
      if (this.containers.has(id)) nameToKey.set(this.containerName(id), id);
    }
    for (const id of req.sidecarIds) nameToKey.set(id, id);
    const result = new Map<string, ResourceUsage>();
    if (nameToKey.size === 0) return result;
    let stdout = '';
    try {
      ({ stdout } = await execFileAsync(
        'docker', ['stats', '--no-stream', '--format', USAGE_STATS_FORMAT, ...nameToKey.keys()],
        { timeout: 15_000, encoding: 'utf-8' },
      ));
    } catch (err) {
      // `docker stats` exits non-zero when ANY name is gone (a sidecar removed
      // between list and stats) but still prints the rows it could read.
      stdout = (err as { stdout?: string }).stdout ?? '';
      if (!stdout) throw err;
    }
    for (const [name, u] of parseUsageStats(stdout)) {
      const key = nameToKey.get(name);
      if (key) result.set(key, u);
    }
    return result;
  }

  public async listOrphanRecords(): Promise<Array<{
    instanceId: string;
    appId:      string;
    port:       number;
    hostname:   string;
    pid:        number;
    tokenNonce?: string;
    ownerLabel?: string;
    address?:   string;
    addresses?: string[];
    dialByAddress?: boolean;
    lifecycleToken?: string;
    preview?: string;
    /** `Config.User` (P5-3): `<uid>:<gid>` of a non-root app; empty for root. A session host's session uid:gid (its label). */
    user?: string;
    /** A session host's session uid:gid (stream T2). */
    sessionUser?: string;
  }> | null> {
    type DockerInspect = {
      Config: { Env: string[]; Labels?: Record<string, string>; User?: string }; State: { Pid: number };
      NetworkSettings?: { Networks?: DockerNetworks };
    };
    let psOut: string;
    try {
      // Names only. `{{json .}}` made the daemon compute every container's
      // disk size (the `Size` column): 2-11 s on a busy host, over the
      // timeout at boot, and a failed scan adopted nothing.
      ({ stdout: psOut } = await execFileAsync('docker', ['ps', '--filter', 'name=aura-', '--format', '{{.Names}}'], {
        encoding: 'utf-8',
        timeout: 15_000,
      }));
    } catch (err) {
      console.warn(`[ContainerRunner] adoption scan: docker ps failed: ${(err as Error).message}`);
      return null;
    }
    const names = psOut.split('\n').map((l) => l.trim()).filter(Boolean);
    const out: Array<{ instanceId: string; appId: string; port: number; hostname: string; pid: number; tokenNonce?: string; ownerLabel?: string; address?: string; addresses?: string[]; dialByAddress?: boolean; lifecycleToken?: string; preview?: string; user?: string; sessionUser?: string }> = [];
    for (const name of names) {
      if (!name.startsWith('aura-')) continue;
      // Skip aura-shell itself — it's not an app instance, just the
      // controller container that owns this runner.
      if (name === 'aura-shell') continue;
      // A survivor whose inspect fails is not "no survivor": skipped, it kept
      // running untracked and its port went to the next spawn (two instances
      // on one port after the following restart, live 0.0.51). One retry with
      // more time (a busy daemon at boot); still unreadable: the scan is
      // incomplete (null, the reconciler retries). Gone since `ps`: skipped.
      let inspect: DockerInspect | null = null;
      for (const timeout of [3_000, 10_000]) {
        try {
          const { stdout: raw } = await execFileAsync('docker', ['inspect', name, '--format', '{{json .}}'], { encoding: 'utf-8', timeout });
          inspect = JSON.parse(raw) as DockerInspect;
          break;
        } catch (err) {
          const why = `${(err as { stderr?: string }).stderr ?? ''} ${(err as Error).message}`;
          if (/no such (object|container)/i.test(why)) break;
          console.warn(`[ContainerRunner] adoption scan: inspect ${name} failed (${timeout} ms): ${(err as Error).message}`);
          if (timeout === 10_000) return null;
        }
      }
      if (!inspect) continue;
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
      // A Terminal listens on its private network (D58): dial it there.
      const termNet = inspect.Config?.Labels?.[TERM_NETWORK_CONTAINER_LABEL];
      const networks = inspect.NetworkSettings?.Networks;
      out.push({
        instanceId,
        appId,
        port,
        hostname: name,
        pid: inspect.State?.Pid ?? 0,
        tokenNonce: inspect.Config?.Labels?.['aura.token.nonce'],
        ownerLabel: inspect.Config?.Labels?.[OWNER_LABEL],
        // The survivor's own address and lifecycle secret, read from the very
        // container inspected here (absent on containers from before tokens).
        address: networks?.[termNet ?? SHARED_NETWORK]?.IPAddress || undefined,
        addresses: networkAddresses(networks),
        ...(termNet ? { dialByAddress: true } : {}),
        // A session host has none in its env: the kernel's own copy (spawn/sessionArgs.ts).
        lifecycleToken: env['AURA_LIFECYCLE_TOKEN'] || readKernelSessionSecret(this.dataDir, instanceId) || undefined,
        ...(inspect.Config?.Labels?.[PREVIEW_LABEL] ? { preview: inspect.Config.Labels[PREVIEW_LABEL] } : {}),
        // A session host runs as root (its launcher): its session identity is the label's (stream T2).
        ...(inspect.Config?.Labels?.[SESSION_IDENTITY_LABEL] ? { user: inspect.Config.Labels[SESSION_IDENTITY_LABEL], sessionUser: inspect.Config.Labels[SESSION_IDENTITY_LABEL] }
          : inspect.Config?.User ? { user: inspect.Config.User } : {}),
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
    address?:   string;
    addresses?: string[];
    dialByAddress?: boolean;
    lifecycleToken?: string;
    sessionUser?: string;
  }): void {
    if (this.containers.has(rec.instanceId)) return;
    // We don't have the container ID handy — docker inspect would have it,
    // but the bookkeeping methods that need it (kill/forceKill/wait/logs)
    // accept the name as a fallback. Set containerId = name; docker accepts either.
    // An adopted container is normally past provisioning, but it can be
    // re-adopted mid-install after an OS restart — so watch its log too.
    const provision = new ProvisionWatch();
    const stillTracked = () => this.containers.get(rec.instanceId)?.containerId === rec.hostname;
    const logTail = spawnDockerWatcher(['logs', '-f', '--tail', '0', rec.hostname], ['ignore', 'pipe', 'pipe'], `${rec.instanceId} logs`, (c) => {
      c.stdout?.on('data', (d: Buffer) => {
        provision.observe(d.toString());
        process.stdout.write(`[${rec.instanceId}] ${d}`);
      });
      c.stderr?.on('data', (d: Buffer) => {
        provision.observe(d.toString());
        process.stderr.write(`[${rec.instanceId}] ${d}`);
      });
      const t = this.containers.get(rec.instanceId);
      if (t && t.containerId === rec.hostname) t.logTail = c;   // a retried tail replaces the failed one
    }, stillTracked);
    this.containers.set(rec.instanceId, {
      containerId:   rec.hostname,
      hostname:      rec.hostname,
      address:       rec.address ?? null,
      dialByAddress: rec.dialByAddress === true,
      addresses:     [...(rec.addresses ?? [])],
      ...(rec.address && rec.lifecycleToken ? { lifecycleToken: rec.lifecycleToken } : {}),
      ...(rec.sessionUser ? { sessionUser: rec.sessionUser } : {}),
      port:          rec.port,
      appId:         rec.appId,
      logTail,
      pid:           rec.pid,
      exitCb:        null,
      expectingKill: false,
      provision,
    });
    // CRITICAL for restart stability: watch the adopted container for exit,
    // exactly like spawn() does. Without this, if an adopted container dies
    // (crash, or an external `docker rm`), AppManager never learns — the
    // instance stays stuck in `resumed`, `start` reuses the phantom and
    // no-ops, and the app can't be recovered without a full shell restart.
    spawnDockerWatcher(['wait', rec.hostname], ['ignore', 'pipe', 'ignore'], `${rec.instanceId} wait`, (c) => {
      c.stdout?.on('data', (d: Buffer) => {
        const code = parseInt(d.toString().trim(), 10);
        this.handleExit(rec.instanceId, isNaN(code) ? null : code, rec.hostname);
      });
    }, stillTracked, () => this.handleExit(rec.instanceId, null, rec.hostname));
  }

  /**
   * Probe the app's health endpoint until ready or timeout, at the address of
   * the container `docker run` created, with the lifecycle token. Stops as
   * soon as that container is no longer the one tracked (it exited: its
   * address may go to someone else).
   */
  private async waitHealthy(instanceId: string, appId: string, containerId: string, port: number): Promise<HealthIdentityClass> {
    // Two clocks, because "not answering yet" has two very different causes.
    //
    // A cold user/global-scope app installs its whole dependency tree in the
    // entrypoint before astro ever starts. Timing that with the boot budget
    // meant every heavy app was killed mid-install on first launch and only
    // worked on the retry that found a warm node_modules. So: while the
    // entrypoint says it is provisioning, keep pushing the boot deadline out —
    // the app has not been asked to start yet — and bound the whole thing with
    // an absolute ceiling so a wedged install still fails instead of hanging.
    const startedAt   = Date.now();
    const hardDeadline = startedAt + PROVISION_TIMEOUT_MS;
    const provision   = this.containers.get(instanceId)?.provision;
    let   deadline    = startedAt + HEALTH_CHECK_TIMEOUT_MS;
    let lastBody: string | null = null;
    while (Date.now() < deadline) {
      const tracked = this.containers.get(instanceId);
      if (!tracked || tracked.containerId !== containerId || !tracked.address) {
        throw new Error(`container ${instanceId} exited before it became healthy`);
      }
      let refusal: string | null = null;
      try {
        const res = await fetch(lifecycleUrl(tracked.address, port, 'health'), {
          headers: lifecycleHeaders(tracked.lifecycleToken), signal: AbortSignal.timeout(5_000),
        });
        // Capture body regardless of status so the timeout error message
        // surfaces what the app actually said (403 = host gate, etc.).
        const body = await res.text();
        lastBody = body;
        if (res.ok) {
          // The shared identity check (lifecycleGate.ts), same as ProotRunner.
          const identity = classifyHealthIdentity(body, appId, instanceId);
          refusal = healthIdentityRefusal(identity, appId, instanceId);
          if (!refusal) {
            if (identity.kind === 'legacy') console.warn(`[ContainerRunner] ${instanceId} health endpoint returned no identity body; admitted as a known legacy app (warn mode).`);
            return identity.kind;
          }
        }
      } catch (e) {
        // Network refused / not ready yet — retry until deadline.
        void e;
      }
      if (refusal) throw new Error(refusal);
      // Re-arm only while provisioning is actually in flight, so the boot
      // budget starts counting from the moment dependencies are ready.
      deadline = nextHealthDeadline({
        now: Date.now(), deadline, hardDeadline,
        isProvisioning: provision?.isProvisioning ?? false,
        bootBudgetMs:   HEALTH_CHECK_TIMEOUT_MS,
      });
      await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
    }
    const waited = Math.round((Date.now() - startedAt) / 1000);
    throw new Error(
      provision?.everProvisioned
        ? `container ${instanceId} did not become healthy ${waited}s after starting to install its dependencies (lastBody=${lastBody?.slice(0, 200)})`
        : `container ${instanceId} did not become healthy within ${HEALTH_CHECK_TIMEOUT_MS}ms (lastBody=${lastBody?.slice(0, 200)})`,
    );
  }

  // ─── Lifecycle hooks (identical shape to ProotRunner) ─────────────────
  async callLifecycle(instanceId: string, hook: string, opts: { reason?: string } = {}): Promise<void> {
    const tracked = this.containers.get(instanceId);
    if (!tracked) return;
    const url = lifecycleUrl(tracked.address ?? tracked.hostname, tracked.port, hook);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), LIFECYCLE_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST', signal: ctrl.signal,
        headers: lifecycleHeaders(tracked.lifecycleToken, opts.reason ? { 'x-aura-stop-reason': opts.reason } : {}),
      });
      if (!res.ok) throw new Error(`${hook} → HTTP ${res.status}`);
    } finally { clearTimeout(t); }
  }
  async callOptionalLifecycle(instanceId: string, hook: string, body?: unknown): Promise<unknown> {
    const tracked = this.containers.get(instanceId);
    if (!tracked) return null;
    const url = lifecycleUrl(tracked.address ?? tracked.hostname, tracked.port, hook);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), LIFECYCLE_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: lifecycleHeaders(tracked.lifecycleToken, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) return null;
      try { return await res.json(); } catch { return null; }
    } catch { return null; }
    finally { clearTimeout(t); }
  }

  // ─── Kill / cleanup ───────────────────────────────────────────────────
  async kill(instanceId: string, opts: { keep?: KeepSiblings } = {}): Promise<void> {
    const tracked = this.containers.get(instanceId);
    if (!tracked) return;
    tracked.expectingKill = true;
    try { execSync(`docker stop -t 5 ${tracked.containerId}`, { stdio: 'ignore', timeout: 8_000 }); } catch { /* may already be dead */ }
    // Stop this instance's sibling runtime containers too (the app's own
    // onDestroy usually tears them down first; this is belt-and-braces so a
    // failed/slow teardown can't leak them). A restart stop keeps the ones
    // that opted in (aura.keep-restart=1); AppManager parks them.
    this.reapSiblingsOf(instanceId, opts);
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
    const t = this.containers.get(instanceId);
    if (!t) return null;
    return t.dialByAddress && t.address ? t.address : t.hostname;
  }
  /** The container's addresses on every network it is on (D28 network identity). */
  addresses(instanceId: string): string[] {
    return [...(this.containers.get(instanceId)?.addresses ?? [])];
  }
  lifecycleStatus(instanceId: string): LifecycleStatus | null {
    return this.containers.get(instanceId)?.lifecycle ?? null;
  }
  /** D89 B4: the relay claim key of this start (from its lifecycle token), or null without one. */
  relayKey(instanceId: string): Buffer | null {
    const token = this.containers.get(instanceId)?.lifecycleToken;
    return token ? relayKey(token) : null;
  }

  /**
   * The same two measurements a fresh start makes (spawn → waitHealthy +
   * checkHealthGuard), for a container adopted after a shell restart. The
   * health probe carries the token only to the bound address, as every
   * lifecycle call does; without an address it asks by name and without the
   * token (health still answers). The runtime check sends a deliberately
   * wrong token, which is no secret. The result is recorded and logged by
   * the mode (`lifecycleStatusRefusal`); in `strict` the refusal is reported,
   * and the running instance is left alone.
   */
  async measureAdopted(instanceId: string): Promise<LifecycleStatus | null> {
    const t = this.containers.get(instanceId);
    if (!t) return null;
    const url = t.address
      ? lifecycleUrl(t.address, t.port, 'health')
      : `http://${t.hostname}:${t.port}${lifecyclePath('health')}`;
    let identity: LifecycleStatus['identity'];
    try {
      const res = await fetch(url, {
        headers: lifecycleHeaders(t.address ? t.lifecycleToken : undefined), signal: AbortSignal.timeout(5_000),
      });
      const body = await res.text();
      if (!res.ok) return null;
      identity = classifyHealthIdentity(body, t.appId, instanceId).kind;
    } catch {
      return null;
    }
    const lifecycle: LifecycleStatus = { identity, guard: await checkHealthGuard(url) };
    // Still the container we measured (it may have exited meanwhile).
    if (this.containers.get(instanceId) !== t) return null;
    t.lifecycle = lifecycle;
    const refusal = lifecycleStatusRefusal(instanceId, lifecycle);
    if (refusal) console.warn(`[ContainerRunner] adopted ${refusal}; left running (it was started by a previous shell)`);
    return lifecycle;
  }
  /**
   * `astro build` an app in a throwaway container — never in aura-shell
   * (its pids budget) and never on the launch path. Same app-dir /
   * node_modules / packages mounts as an app container, so the build sees
   * exactly what the running app sees; capped (pids, memory, cpus) so a build
   * can't starve the running apps. The staging directory is mounted AS `dist`:
   * paths baked into the output are the real ones, and the `dist/` a running
   * instance loads from is untouched. The caller installs the result
   * (installBuild) and writes the build stamp.
   */
  /**
   * The read-only slice of /workspace every app container and app build
   * sees: the packages and the workspace root files they resolve against.
   * tsconfig.base.json because packages/<pkg>/tsconfig.json extends it:
   * Vite 8 (Astro 7) reads the tsconfig of every file it transforms and
   * fails on a missing `extends`, where Vite 7 went on without it.
   */
  workspaceMounts(): string[] {
    return [
      '-v', `${this.workspaceRoot}/packages:/workspace/packages:ro`,
      ...WORKSPACE_ROOT_FILES.flatMap((f) => ['-v', `${this.workspaceRoot}/${f}:/workspace/${f}:ro`]),
    ];
  }

  /** Shell-side pids of the `docker run` clients of running builds (getActivePids). */
  private readonly buildPids = new Set<number>();

  async buildApp(appId: string, appDir: string, opts: { timeoutMs?: number } = {}): Promise<{ ok: boolean; output: string }> {
    await whenBaseImageReady();
    const name = `aura-build-${appId.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    const args = [
      'run', '--rm', '--name', name,
      '--pids-limit', '512', '--memory', '3g', '--cpus', '2',
      '--workdir', `/workspace/apps/${appId}`,
      ...this.buildAppDirMount(appDir, appId, this.appDataVolume),
      ...this.buildAppDirMount(`${appDir}/dist/${BUILD_STAGING_DIR}`, appId, this.appDataVolume, `/workspace/apps/${appId}/dist`),
      ...this.workspaceMounts(),
      '--mount', `type=volume,source=${this.nodeModulesVolume},target=/workspace/node_modules,readonly`,
      '-e', 'NODE_ENV=production', '-e', 'GOMAXPROCS=2', '-e', `APP_ID=${appId}`,
      '-e', 'ASTRO_TELEMETRY_DISABLED=1',
      BASE_IMAGE,
      'bash', '-c',
      'set -e; ASTRO=node_modules/.bin/astro; [ -x "$ASTRO" ] || ASTRO=/workspace/node_modules/.bin/astro; exec "$ASTRO" build',
    ];
    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    return await new Promise((resolve) => {
      let output = '';
      const keep = (d: Buffer) => { output = (output + d.toString()).slice(-16_000); };
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], env: WATCHER_ENV });
      const pid = child.pid;
      if (pid) this.buildPids.add(pid);
      const untrack = () => { if (pid) this.buildPids.delete(pid); };
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      const timer = setTimeout(() => {
        keep(Buffer.from(`\n[build] timed out after ${Math.round(timeoutMs / 1000)} s\n`));
        try { spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 20_000 }); } catch { /* gone */ }
      }, timeoutMs);
      child.on('error', (err) => { clearTimeout(timer); untrack(); resolve({ ok: false, output: `${output}\n${err.message}` }); });
      child.on('close', (code) => { clearTimeout(timer); untrack(); resolve({ ok: code === 0, output }); });
    });
  }

  /**
   * Install an app's dependencies in a throwaway builder container (P5-3):
   * the start shell's own provisioning block (`provisionShell`), run as root
   * inside that container only, on the shared network (the local registry
   * serves `@aura/*`), with no socket, no home, no context, no token and no
   * raw sockets. Package caches live in the builder cache dir
   * (`/data/aura/cache/builder`, root, 0700), never in a home. The app never
   * runs here. Capped like a build.
   */
  async provisionApp(
    appId: string, appDir: string, runtime: 'astro' | 'raw', opts: { timeoutMs?: number; onLine?: (line: string) => void } = {},
  ): Promise<{ ok: boolean; output: string }> {
    await whenBaseImageReady();
    const cacheDir = join(this.dataDir, BUILDER_CACHE_SUBPATH);
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    chmodSync(cacheDir, 0o700);
    const name = `aura-provision-${appId.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    // `oras` for `aura sdk install`, as OS infrastructure (BUILDER_TOOLS).
    const tools = provisionBuilderTools({ dataDir: this.dataDir, appDataVolume: this.appDataVolume, name });
    if (tools.missing.length) console.warn(`[provision] ${appId}: the builder lacks ${tools.missing.join(', ')} (not in the toolchain)`);
    const args = [
      'run', '--rm', '--name', name,
      '--network', SHARED_NETWORK, ...rawSocketArgs(),
      '--pids-limit', '512', '--memory', '3g', '--cpus', '2',
      '--workdir', `/workspace/apps/${appId}`,
      ...this.buildAppDirMount(appDir, appId, this.appDataVolume),
      ...this.workspaceMounts(),
      '--mount', `type=volume,source=${this.nodeModulesVolume},target=/workspace/node_modules,readonly`,
      '--mount', `type=volume,source=${this.appDataVolume},target=${BUILDER_CACHE_PATH},volume-subpath=${BUILDER_CACHE_SUBPATH}`,
      ...tools.args,
      ...builderProvisionEnv(appId),
      BASE_IMAGE,
      'bash', '-c', builderProvisionShell(runtime),
    ];
    const timeoutMs = opts.timeoutMs ?? PROVISION_TIMEOUT_MS;
    return await new Promise((resolve) => {
      let output = '';
      const keep = (d: Buffer) => {
        output = (output + d.toString()).slice(-16_000);
        if (opts.onLine) for (const l of d.toString().split('\n')) if (l.trim()) opts.onLine(l.trim());
      };
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], env: WATCHER_ENV });
      const pid = child.pid;
      if (pid) this.buildPids.add(pid);
      const untrack = () => { if (pid) this.buildPids.delete(pid); tools.release(); };
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      const timer = setTimeout(() => {
        keep(Buffer.from(`\n[provision] timed out after ${Math.round(timeoutMs / 1000)} s\n`));
        try { spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 20_000 }); } catch { /* gone */ }
      }, timeoutMs);
      child.on('error', (err) => { clearTimeout(timer); untrack(); resolve({ ok: false, output: `${output}\n${err.message}` }); });
      child.on('close', (code) => { clearTimeout(timer); untrack(); resolve({ ok: code === 0, output }); });
    });
  }

  /** Run `argv` in the instance's container (`docker exec`), in its app dir. */
  async exec(instanceId: string, argv: string[], opts: SandboxExecOpts = {}): Promise<{ stdout: string; stderr: string }> {
    const c = this.containers.get(instanceId);
    if (!c || !argv.length) throw new Error(`${instanceId} is not running in a container`);
    const envFlags = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    // A session host's container runs as root (its launcher): an exec runs as its session user (stream T2).
    const user = c.sessionUser ? ['--user', c.sessionUser] : [];
    return execFileAsync('docker', ['exec', '-w', `/workspace/apps/${c.appId}`, ...user, ...envFlags, this.containerName(instanceId), ...argv], {
      timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024,
    });
  }

  /**
   * An instance's own output, the engine's log of its container (the module's
   * `logs`, 5b-2 D-X). An untracked instance keeps no log here.
   */
  async instanceLogs(instanceId: string, req: RuntimeLogsRequest, onChunk: (stream: RuntimeOutputStream, data: Buffer) => void): Promise<RuntimeLogsStream> {
    if (!this.containers.has(instanceId)) throw new ExecBridgeError(409, 'runtime-unsupported', `${instanceId} keeps no output log`);
    return engineLogs(this.engine(), this.containerName(instanceId), req, onChunk);
  }

  /** What a port forwarder is created with (the module's `endpoints`, 5b-2 D-P). */
  forwarderFacts(): ForwarderFacts {
    return { image: BASE_IMAGE, network: SHARED_NETWORK, rawSocketArgs: rawSocketArgs() };
  }

  /** A process in a running associated workload (`workloads.exec`, 5b-2 D-X): an Engine exec in its container. */
  execWorkload(workloadId: string, spec: RuntimeWorkloadExec, onOutput: (channel: 1 | 2, data: Buffer) => void): Promise<ExecSession> {
    return engineExec(this.engine(), workloadId, spec, onOutput);
  }

  /** An associated workload's own output (`workloads.logs`). */
  workloadLogs(workloadId: string, req: RuntimeLogsRequest, onChunk: (stream: RuntimeOutputStream, data: Buffer) => void): Promise<RuntimeLogsStream> {
    return engineLogs(this.engine(), workloadId, req, onChunk);
  }

  private engine(): EngineClient {
    return (this.engineClient ??= new DockerApi());
  }

  /** The Engine API client (stream X's), shared by the session broker. */
  private engineClient: EngineClient | null = null;
  private broker: SessionBroker | null = null;
  /** Tests: a fake engine and broker. */
  setSessionBroker(engine: EngineClient, broker: SessionBroker): void { this.engineClient = engine; this.broker = broker; }
  private sessionBroker(): { engine: EngineClient; broker: SessionBroker } {
    this.engineClient ??= new DockerApi();
    this.broker ??= new SessionBroker({
      engine: this.engineClient, dataDir: this.dataDir, appDataVolume: this.appDataVolume,
      dockerCli: () => { const p = join(toolchainMirrorBin(this.dataDir), 'docker'); return existsSync(p) ? p : null; },
    });
    return { engine: this.engineClient, broker: this.broker };
  }

  /** The open in-environment sessions (diagnose, root tabs). */
  openSessions(): ReturnType<SessionBroker['sessions']> {
    return this.broker?.sessions() ?? [];
  }

  /** Ends one open session (End of a root tab). */
  endSession(sessionId: string): Promise<boolean> {
    return this.broker?.end(sessionId) ?? Promise.resolve(false);
  }

  /**
   * Stream J (D74): a session inside the RUNNING app container, through the
   * session broker. The container's own non-secret env (SESSION_APP_ENV) is
   * the session's base; the kernel's spec decides identity, home and the rest.
   */
  async openSession(instanceId: string, spec: SessionSpec, onOutput: (channel: 1 | 2, data: Buffer) => void): Promise<ExecSession> {
    const c = this.containers.get(instanceId);
    if (!c) throw new ExecBridgeError(409, 'not-running', `${instanceId} is not running in a container`);
    const { engine, broker } = this.sessionBroker();
    const info = await engine.containerInspect(this.containerName(instanceId));
    if (!info.State?.Running || !info.State.Pid || !info.Id) throw new ExecBridgeError(409, 'not-running', `${instanceId} is not running`);
    if (info.State.Paused) throw new ExecBridgeError(409, 'not-running', `${instanceId} is paused`);
    const env: Record<string, string> = {};
    for (const kv of info.Config?.Env ?? []) {
      const at = kv.indexOf('=');
      if (at > 0 && SESSION_APP_ENV.has(kv.slice(0, at))) env[kv.slice(0, at)] = kv.slice(at + 1);
    }
    return broker.openSession({
      ...spec, env: { ...env, ...spec.env }, cwd: spec.cwd ?? `/workspace/apps/${c.appId}`,
    }, { containerId: info.Id, pid: info.State.Pid, ...sessionHostTarget(info.Config?.Labels?.[SESSION_IDENTITY_LABEL]) }, onOutput);
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
    // The exception: the `docker run` clients of running app builds live in
    // the shell's namespace and their cmdline names the app dir — without
    // this the reaper takes them for squatters.
    return [...this.buildPids];
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

/**
 * Whether an app's own source is mounted read-only into its container (Track
 * P): a closed install that is an agent workspace — granted every tool (`*`),
 * like the System Terminal, where Claude and Codex run — and that serves its
 * build. Other apps keep writing their own dir (`.data/`, astro dev's
 * `.astro/` and vite cache), and so does an agent workspace in dev mode
 * (no matching build), which could not start otherwise.
 *
 * Known limit: the System Terminal holds the Docker socket, so read-only is
 * a guardrail for agents until Phase 5 removes the socket (D30).
 */
export function ownSourceReadOnly(ctx: { appDir: string; sourceMode?: 'closed' | 'open' }, manifest: AppManifest): boolean {
  if (ctx.sourceMode !== 'closed' || !(manifest.tools ?? []).includes('*')) return false;
  return serveState(ctx.appDir, manifest).mode === 'prod';
}

/** `docker run` of the D80 idmap probe (paths are daemon host paths; nothing comes from a request). */
export function idmapProbeArgs(o: { helper: string; scratch: string; image: string }): string[] {
  return [
    'run', '--rm', '--privileged', '--network', 'none', '--label', 'aura.mount=1',
    '-v', `${o.helper}:${IDMAP_HELPER_PATH}:ro`, '-v', `${o.scratch}:/probe`,
    o.image, IDMAP_HELPER_PATH, 'idmap-probe', '/probe',
  ];
}
