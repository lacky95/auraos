import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AppManifest } from '../types/manifest.js';
import { lifecyclePath } from '../types/manifest.js';
import { ALL_TOOLS_PATH, MY_TOOLS_PATH, SHARED_HOME_PATH, currentToolsMode, provisionAllowlist } from './tool-provision.js';
import { prootHomeBind } from './spawn/homeArgs.js';
import { prootContextBinds } from './spawn/contextArgs.js';
import { prootIdentityLaunch, requireProotIdentity, writeIdentityFiles } from './spawn/identityArgs.js';
import { WORKSPACE_ROOT_FILES } from './ContainerRunner.js';
import type { SpawnIdentity } from '../identity/types.js';
import type { RuntimeCapabilities, RuntimeSettings } from '../runtimes/types.js';
import type { SandboxExecOpts, SandboxRunner, SandboxRunnerOpts } from './SandboxRunner.js';
import { OutputLog } from './outputLog.js';
import type { SpawnContext } from '../scopes/types.js';
import { VolumeStore } from '../context/VolumeStore.js';
import { prootUnavailable } from '../runtimes/proot/host.js';
import {
  ASTRO_START_SHELL, RAW_START_SHELL, PROVISION_TIMEOUT_MS, ProvisionWatch, nextHealthDeadline,
} from './provisioning.js';
import { serveState } from './appBuild.js';
import {
  checkHealthGuard, classifyHealthIdentity, healthIdentityRefusal, lifecycleHeaders, lifecycleStatusRefusal,
  newLifecycleToken, relayStrictEnv, type HealthIdentityClass, type LifecycleStatus,
} from './lifecycleGate.js';
import { relayKey } from '../app-hosts/relayClaim.js';

const HEALTH_CHECK_INTERVAL_MS = 200;
const HEALTH_CHECK_TIMEOUT_MS = 30_000;
const LIFECYCLE_TIMEOUT_MS = 5_000;

/**
 * Default entrypoint command used when the app dir has no `entrypoint.sh`.
 * Equivalent to the historical per-app entrypoint.sh — every app shipped a
 * byte-identical copy of this script except for the app name in `echo`,
 * which we now substitute from `$APP_ID`. With the SDK consolidation pass
 * apps stop shipping `entrypoint.sh` and ProotRunner synthesises this
 * inline command instead.
 *
 * Kept identical in spirit to the old script so the install-on-first-run
 * fallback still works when a freshly scaffolded app doesn't yet have a
 * populated `node_modules` (e.g. before the workspace `pnpm install` ran).
 */
// Shared with ContainerRunner (provisioning.ts ASTRO_START_SHELL): astro
// dev, or the production build when it matches the sources (AURA_SERVE).
const SYNTHESISED_ENTRYPOINT = ASTRO_START_SHELL;

/** The PATH of a PRoot app process: its granted tools first, then the rootfs (as in an app container). */
const PROOT_PATH = `${MY_TOOLS_PATH}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

/**
 * How an instance is launched: `command` with `prefix` before the app's own
 * argv (the identity drop, then `proot` and its binds), the env and the
 * shell-side cwd. `exec` runs a command the same way, so it joins the same
 * sandbox as the same identity.
 */
export interface ProotLaunch {
  command: string;
  prefix: string[];
  env: Record<string, string>;
  appDir: string;
}

interface SpawnedApp {
  process: ChildProcess;
  /** Watches the app's output to tell "installing dependencies" from
   *  "failing to boot" — see provisioning.ts. */
  provision: ProvisionWatch;
  port: number;
  appId: string;
  /** How the instance was launched, so `exec` can join the same sandbox. */
  launch: ProotLaunch;
  /** This start's lifecycle secret (also `AURA_LIFECYCLE_TOKEN` in `launch.env`). */
  lifecycleToken: string;
  /** Health identity and runtime-check result, once healthy. */
  lifecycle?: LifecycleStatus;
}

/** What `prootBinds` lays out: everything resolved by the runner. */
export interface ProotBindSpec {
  rootfs: string;
  /** Bound at /data. */
  instanceDataDir: string;
  /** The app's source, bound at its own path and the cwd. */
  appDir: string;
  /** The `/home/aura` bind (spawn/homeArgs.ts). */
  homeBind: string;
  /** The instance's own `/tmp` (a host dir owned by its app identity). */
  tmpDir: string;
  /** `/etc/passwd` and `/etc/group` of the app identity (spawn/identityArgs.ts). */
  identityBinds: string[];
  /** The Context Volumes (spawn/contextArgs.ts); never `/run/context`. */
  contextBinds: string[];
  /** The allowlist dir, and the store too in legacy symlink mode; null without a toolchain. */
  tools: { myTools: string; allTools: string | null } | null;
}

/**
 * The PRoot bind topology of one instance, in one place (ARI §9.3): the
 * master placement uses it; the pool placement (5-post) reuses it rather
 * than a second copy. Returns the sandbox arguments before the entrypoint.
 *
 * Narrowed (Phase 5 R2, Q18b): of `/workspace` only what an app container
 * gets too (ContainerRunner `workspaceMounts`: node_modules, packages, the
 * pnpm root files, the capability registry) plus the app's own dir; no
 * `/run/context`, no Docker socket, the App Home and a per-instance `/tmp`.
 * PRoot binds are writable whatever their intent: what keeps the shared
 * pieces read-only is that they are root- or owner-owned and the app runs
 * as its own uid (`requireProotIdentity`).
 */
export function prootBinds(spec: ProotBindSpec): string[] {
  // pnpm workspace creates node_modules as a forest of relative symlinks
  // (e.g. `node_modules/astro → ../../node_modules/.pnpm/astro@.../astro`).
  // Those resolve correctly ONLY if the app dir keeps its `/workspace/apps/<id>`
  // absolute path inside the PRoot. We therefore drop the `/app` alias and
  // use the workspace path as cwd; `APP_ID`/`APP_INSTANCE_ID` env vars give
  // the app its identity instead.
  const args = [
    `--rootfs=${spec.rootfs}`,
    // The shared workspace pieces those symlinks and `@aura/*` resolve
    // against; never the other apps' sources or the OS source tree.
    '--bind=/workspace/node_modules:/workspace/node_modules',
    '--bind=/workspace/packages:/workspace/packages',
    ...WORKSPACE_ROOT_FILES.map((f) => `--bind=/workspace/${f}:/workspace/${f}`),
    // The capability registry, so a sandboxed `aura cap …` reads the real one.
    '--bind=/workspace/.aura:/workspace/.aura',
    `--bind=${spec.instanceDataDir}:/data`,
    // As a non-root tracee, /proc/<master pid>/root and /environ are closed by the kernel.
    '--bind=/proc',
    '--bind=/dev',
    // The instance's own /tmp: never the master's (its sockets and files).
    `--bind=${spec.tmpDir}:/tmp`,
    '--bind=/etc/resolv.conf:/etc/resolv.conf',
    // Bring the master container's Node 22 into the sandbox — Debian-bookworm
    // ships Node 18 in its package archive, which is too old for our apps.
    '--bind=/usr/local/bin/node:/usr/local/bin/node',
    // The App Home the kernel resolved (spawn/homeArgs.ts, D65), never the
    // user's Private Home. Without this bind a PRoot's HOME resolves inside the
    // base-rootfs (/os/base-rootfs/root), which is an IMAGE LAYER: every
    // tool dotfile written there is destroyed by the next `compose up
    // --build` or container recreate.
    spec.homeBind,
    // The app identity's account, so `id`, git and ssh know it.
    ...spec.identityBinds,
    // OS-managed shared Context Volumes (spawn/contextArgs.ts).
    ...spec.contextBinds,
    // Expose the app's own source dir at its real absolute path. Required for
    // user/global-scope apps, whose appDir lives UNDER /data (e.g.
    // /data/scopes/users/<u>/apps/<id>): the `${dataDir}:/data` bind above
    // remaps /data to the per-instance data dir, which would otherwise shadow
    // the app source — `chdir(appDir)` then fails and proot falls back to `/`,
    // so `astro dev` never finds package.json/node_modules. Binding appDir
    // onto itself overlays that subtree back. For system-scope apps (appDir
    // under /workspace/apps) it is the one app dir the sandbox sees.
    `--bind=${spec.appDir}:${spec.appDir}`,
    `--cwd=${spec.appDir}`,
  ];

  // Toolchain tools override the base-rootfs versions if a matching binary
  // is present (e.g. host's `claude` cli). Tools the manifest doesn't declare
  // stay invisible inside the sandbox.
  //
  // Resolve symlinks before constructing the bind argument: PRoot's bind
  // mishandles a source path that is itself a symlink — `lstat` inside the
  // sandbox sees it as a symlink but `readlink` returns EINVAL, which makes
  // Node's `realpathSync` throw on entry-point resolution. Binding the
  // resolved target (a regular file) sidesteps that entirely. Capabilities
  // installed by `aura cap install` use symlinks, so this fix matters for
  // every dynamically added tool, not just `aura` itself.
  // Toolchain view. /aura/my-tools is the per-instance allowlist dir,
  // mutated from OUTSIDE the proot at cap-grant / cap-install time — the
  // bind is at the directory level, so live instances see new tools without
  // a respawn. bashrc + spawn env prepend it to PATH.
  //
  // /aura/all-tools (the whole toolchain store) is bound ONLY in legacy
  // symlink mode, where the allowlist entries are symlinks that need that
  // path to resolve against. In hardlink mode the allowlist entries ARE the
  // binaries, so binding the store would just hand every app every tool by
  // absolute path and defeat the grant. See tool-provision.ts.
  if (spec.tools) {
    if (spec.tools.allTools) args.push(`--bind=${spec.tools.allTools}:${ALL_TOOLS_PATH}`);
    args.push(`--bind=${spec.tools.myTools}:${MY_TOOLS_PATH}`);
  }

  return args;
}

/** Owned by the PRoot module; re-exported for the runner's callers. */
export { prootUnavailable };

/** PRoot's placements (ARI-1): `master` (the default) and `pool`. */
export type ProotPlacement = 'master' | 'pool';

/**
 * What PRoot can do, per placement (ARI §2.3, Phase 5 R2). Both run
 * ptrace-wrapped processes under the installation's app uid, which the
 * kernel enforces (D70); neither enforces read-only binds, so closed apps
 * fail closed (ARI-4); neither opens an isolated session or is a Private Home
 * boundary (D65, J.5); no mounts, port expose or sidecars; processes end with
 * the shell (D77). They differ only in their network: the shell's namespace
 * (`shell-netns`) vs `aura-net` (`bridge`).
 */
const PTRACE_CAPABILITIES: Omit<RuntimeCapabilities, 'network'> = Object.freeze({
  isolation: 'ptrace',
  appHome: true,
  privateHomeSession: false,
  sessionExec: false,
  identity: 'enforced',
  readOnlyBinds: false,
  hostFilesystem: true,
  mounts: false,
  idmappedMounts: false,
  portExpose: false,
  sidecars: false,
  warmPool: true,
  survivesShellRestart: false,
  usage: false,
  gpu: false,
});
export const PROOT_CAPABILITIES: Readonly<Record<ProotPlacement, RuntimeCapabilities>> = Object.freeze({
  master: Object.freeze({ ...PTRACE_CAPABILITIES, network: 'shell-netns' as const }),
  pool: Object.freeze({ ...PTRACE_CAPABILITIES, network: 'bridge' as const }),
});

const execFileAsync = promisify(execFile);

/** How many instances' output rings a runner keeps (running ones always). */
const OUTPUT_LOGS_KEPT = 64;

export class ProotRunner implements SandboxRunner {
  private processes = new Map<string, SpawnedApp>();
  /**
   * Each instance's own output (`aura logs`, GET /api/instances/:id/logs):
   * PRoot has no engine log. Kept past the exit for a crash's last words,
   * replaced on the next spawn, and bounded to the newest OUTPUT_LOGS_KEPT.
   */
  private outputs = new Map<string, OutputLog>();
  private baseRootfs: string;
  private toolchainDir: string;
  private appsDir: string;
  private dataDir: string;
  private osApiBase: string;
  /** OS-managed shared volumes, bound into every sandbox. */
  private volumeStore: VolumeStore;

  constructor(opts: SandboxRunnerOpts) {
    this.baseRootfs = opts.baseRootfs;
    this.toolchainDir = opts.toolchainDir;
    this.appsDir = opts.appsDir;
    this.dataDir = opts.dataDir;
    this.osApiBase = opts.osApiBase;
    this.volumeStore = new VolumeStore(opts.dataDir);
  }

  /**
   * Host-side path of the per-instance tool allowlist dir. This is what we
   * bind into the proot at /aura/my-tools. Lives under dataDir so it shares
   * the same volume + cleanup lifecycle as the instance's other state.
   */
  public toolsDir(instanceId: string): string {
    return join(this.dataDir, 'aura', 'runtime', instanceId, 'tools');
  }

  /** The placement's capabilities (master unless the settings say `pool`). */
  public capabilities(settings?: RuntimeSettings): RuntimeCapabilities {
    const placement: ProotPlacement = settings?.['placement'] === 'pool' ? 'pool' : 'master';
    return { ...PROOT_CAPABILITIES[placement] };
  }

  /**
   * Recreate the per-instance allowlist so it holds exactly the binaries this
   * app's `tools[]` grants — hardlinks from the toolchain mirror by default,
   * symlinks into /aura/all-tools on filesystems that can't hardlink. See
   * tool-provision.ts for the two modes and why the mode decides whether
   * prootBinds also binds the shared store.
   *
   * Apps with `'*'` in tools[] get every entry in the toolchain; explicit-list
   * apps get just their declared tools (with the historical `claude-code` →
   * `claude` rename preserved). Called once at spawn AND on cap
   * grant/revoke/install for live instances — so a running terminal sees a new
   * capability appear in PATH without a respawn.
   */
  public provisionToolsDir(instanceId: string, manifest: Pick<AppManifest, 'tools'>): string {
    const dir = this.toolsDir(instanceId);
    provisionAllowlist({
      dataDir: this.dataDir,
      dir,
      tools: manifest.tools,
      // PRoot binds the real store at /aura/all-tools (it lives in the shell's
      // own mount namespace), so that's what legacy mode enumerates.
      legacyStoreBin: join(this.toolchainDir, 'bin'),
    });
    return dir;
  }

  /** Tear down the per-instance allowlist dir. Called on instance destroy. */
  public clearToolsDir(instanceId: string): void {
    try { rmSync(this.toolsDir(instanceId), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  /**
   * The instance's own `/tmp` (`<dataDir>/aura/runtime/<inst>/tmp`): emptied
   * at every start, 0700 and owned by its app identity, so no other app (and
   * nothing of the master's /tmp) is in it. Its parent stays root-owned.
   */
  private instanceTmpDir(instanceId: string, identity: SpawnIdentity): string {
    const dir = join(this.dataDir, 'aura', 'runtime', instanceId, 'tmp');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    chownSync(dir, identity.uid, identity.gid);
    return dir;
  }

  async spawn(instanceId: string, appId: string, port: number, manifest: AppManifest, ctx: SpawnContext): Promise<number> {
    const appDir = ctx.appDir;
    // Fail closed (D75, D92): no `proot-host` switch or no rootfs means no
    // start; PRoot never runs an app unwrapped. The manifest's `useProot` is
    // not read (Q17). The runtime refuses this before a start already
    // (runtimes/proot/index.ts); this keeps the runner from ever doing it.
    const why = prootUnavailable(process.env, this.baseRootfs);
    if (why) throw new Error(`[ProotRunner] runtime proot is not available: ${why}`);
    // D65: the resolved App Home, or no start.
    const homeBind = prootHomeBind({ home: ctx.home });
    // Q18b: the app identity, or no start (never root).
    const identity = requireProotIdentity(appId, ctx.identity);
    const entrypointArgv = this.resolveEntrypoint(appDir, manifest);
    // Materialise the per-instance tool allowlist BEFORE building the args
    // (the args reference the dir). Wildcard apps get the whole store mirrored;
    // explicit apps get just their declared tools.
    this.provisionToolsDir(instanceId, manifest);
    // OS-managed shared volumes — bound into the proot (RW; proot --bind can't
    // enforce read-only: an RO volume is protected only by its ownership).
    await this.volumeStore.ensureAll();
    const contextVolumes = await this.volumeStore.resolveMounts();
    const ident = prootIdentityLaunch(identity, writeIdentityFiles(this.dataDir, instanceId, identity, ctx.installationId ?? null));
    const toolBinDir = join(this.toolchainDir, 'bin');
    const sandboxArgs = prootBinds({
      rootfs: this.baseRootfs,
      instanceDataDir: ctx.instanceDataDir,
      appDir,
      homeBind,
      tmpDir: this.instanceTmpDir(instanceId, identity),
      identityBinds: ident.binds,
      contextBinds: prootContextBinds({ volumesDir: this.volumeStore.volumesDir, volumes: contextVolumes }),
      tools: existsSync(toolBinDir)
        ? { myTools: this.toolsDir(instanceId), allTools: currentToolsMode(this.dataDir) === 'symlink' ? toolBinDir : null }
        : null,
    });

    // A clean env (Q18b): nothing of the master's own environment, only what
    // an app container gets too. Context keys first, so the fixed OS vars
    // below override them (a context key can't clobber PATH/APP_ID/HOME …).
    // The granted tools' shared libraries need no env var here: tools with
    // staged libs are wrapper scripts that scope LD_LIBRARY_PATH to their own
    // process tree (see provisionAllowlist).
    const shellHostname = process.env['AURA_SHELL_HOSTNAME'];
    const env: Record<string, string> = {
      // The Context keys the kernel granted this start (declared AND granted,
      // stream C); the fixed OS vars below override, so a key can't clobber them.
      ...(ctx.contextEnv ?? {}),
      PATH: PROOT_PATH,
      // The App Home, through the bind in prootBinds (never the master's home).
      HOME: SHARED_HOME_PATH,
      // Terminal-capability env so TUI apps render their rich versions (as in an app container).
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      APP_ID: appId,
      APP_INSTANCE_ID: instanceId,
      APP_PORT: String(port),
      OS_API_BASE: this.osApiBase,
      // prod = start from the app's build (matches its sources), dev = astro
      // dev; read by ASTRO_START_SHELL (appBuild.ts serveState).
      AURA_SERVE: serveState(ctx.appDir, manifest).mode,
      // Statically known, so the /root/.bashrc prompt snippet never has to
      // shell out to detect layers (~100–300 ms off every interactive
      // terminal launch). Bash startup .bashrc reads $AURA_LAYER_TAG verbatim.
      AURA_LAYER_TAG: '[proot+ctnr]',
      AURA_HOSTNAME: appId,
      ...(shellHostname ? { AURA_SHELL_HOSTNAME: shellHostname } : {}),
      // Which allowlist mode the OS provisioned this instance with (tool-provision.ts).
      AURA_TOOLS_MODE: currentToolsMode(this.dataDir),
      ...ident.env,
      // Same bearer ContainerRunner injects. The token-gated sidecar routes
      // still answer 409 for proot sandboxes; carrying it keeps identity
      // uniform across runners.
      ...(ctx.instanceToken ? { AURA_INSTANCE_TOKEN: ctx.instanceToken.token } : {}),
      // Per-start shell→app secret for the lifecycle routes (lifecycleGate.ts).
      AURA_LIFECYCLE_TOKEN: newLifecycleToken(),
      // D89 B4: a strict relay mode (app-sdk shell-peer); nothing in the default `warn`.
      ...relayStrictEnv(),
    };
    // Drop to the app identity, then proot with the binds; the app's argv follows.
    const launch: ProotLaunch = { command: ident.command, prefix: [...ident.prefix, 'proot', ...sandboxArgs], env, appDir };

    try {
      return await this.startProcess(instanceId, appId, port, launch, entrypointArgv);
    } catch (err) {
      // A production build that won't boot (it exits, or never answers) must
      // not leave the app dead: the sources are right there, so `astro dev`
      // is a working fallback. Store-installed apps hit this first — their
      // build was made on this machine and nobody watched it boot.
      if (env['AURA_SERVE'] !== 'prod' || !(err instanceof StartupFailure)) throw err;
      console.warn(`[ProotRunner] ${instanceId}: production build failed to start — retrying with astro dev`);
      return await this.startProcess(instanceId, appId, port, { ...launch, env: { ...env, AURA_SERVE: 'dev' } }, entrypointArgv);
    }
  }

  /** Spawn the sandbox once and wait until it is healthy, or fail loud. */
  private async startProcess(
    instanceId: string, appId: string, port: number, launch: ProotLaunch, entrypointArgv: string[],
  ): Promise<number> {
    console.log(`[ProotRunner] Spawning ${instanceId} (app=${appId}) on port ${port} (serve=${launch.env['AURA_SERVE']})`);

    // detached: true makes the sandbox a process-group leader so we can
    // SIGKILL the entire group on cleanup (including any detached astro
    // children). Without it, kill() only signals the proot pid and orphan
    // astros survive on the bound port — that's the squatter that caused the
    // wrong-content bug. `setpriv` execs proot, so the pid stays the leader.
    const child = spawn(launch.command, [...launch.prefix, ...entrypointArgv],
      { cwd: launch.appDir, env: launch.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });

    const provision = new ProvisionWatch();
    const tail = new OutputTail();
    const output = new OutputLog();
    this.outputs.delete(instanceId);
    this.outputs.set(instanceId, output);
    for (const id of this.outputs.keys()) {
      if (this.outputs.size <= OUTPUT_LOGS_KEPT) break;
      if (!this.processes.has(id) && id !== instanceId) this.outputs.delete(id);
    }
    child.stdout?.on('data', (d) => {
      provision.observe(d.toString());
      tail.push(d.toString());
      output.push('out', d.toString());
      process.stdout.write(`[${instanceId}] ${d}`);
    });
    child.stderr?.on('data', (d) => {
      provision.observe(d.toString());
      tail.push(d.toString());
      output.push('err', d.toString());
      process.stderr.write(`[${instanceId}] ${d}`);
    });
    // An app that dies while booting used to surface only as "did not become
    // healthy within 30000ms" — no exit code, no reason. Record the exit so
    // waitHealthy can fail at once and say why.
    let exited: string | null = null;
    child.once('exit', (code, signal) => { exited = signal ? `signal ${signal}` : `code ${code}`; });
    child.once('error', (err) => { exited = `spawn error: ${err.message}`; });

    const spawned: SpawnedApp = {
      process: child, port, appId, provision, launch,
      lifecycleToken: launch.env['AURA_LIFECYCLE_TOKEN']!,
    };
    this.processes.set(instanceId, spawned);

    try {
      const identity = await this.waitHealthy(instanceId, appId, port, () => exited);
      const lifecycle: LifecycleStatus = { identity, guard: await checkHealthGuard(this.lifecycleUrl(port, 'health')) };
      const refusal = lifecycleStatusRefusal(instanceId, lifecycle);
      if (refusal) throw new Error(`[ProotRunner] ${refusal}`);
      spawned.lifecycle = lifecycle;
    } catch (err) {
      // Either timeout, early exit or identity mismatch — clean up the partial
      // spawn so we don't leak an orphan process or a stale instance entry.
      // Caller is responsible for releasing the port.
      const out = tail.text();
      console.error(
        `[ProotRunner] ${instanceId} health-check failed: ${(err as Error).message}` +
        (out ? `\n[ProotRunner] ${instanceId} last output:\n${out}` : ` (no output)`),
      );
      this.forceKill(instanceId);
      throw err;
    }
    return child.pid ?? 0;
  }

  /**
   * Decide what to actually exec to start the app's server.
   *   • Astro runtime (default): app ships `entrypoint.sh` → run it directly;
   *     no entrypoint file → fall back to the synthesised astro-dev command.
   *   • Raw runtime: an explicit `manifest.entrypoint` file is REQUIRED. The
   *     synthesised astro fallback is intentionally not used — a raw app
   *     that ships nothing has no defensible default to spawn. Throw with a
   *     clear message so the manifest error surfaces at spawn time, not in
   *     the form of a hung health check. It is provisioned like an Astro
   *     app first (RAW_START_SHELL), then its entrypoint runs.
   */
  private resolveEntrypoint(appDir: string, manifest: AppManifest): string[] {
    const entrypointPath = join(appDir, manifest.entrypoint);
    const entrypointExists = existsSync(entrypointPath);
    if (manifest.runtime === 'raw') {
      if (!entrypointExists) {
        throw new Error(
          `[ProotRunner] app '${manifest.id}' has runtime: 'raw' but no entrypoint file at ${entrypointPath}. ` +
          `Raw apps must ship an executable entrypoint that binds the app to $APP_PORT.`,
        );
      }
      // Provision first (npm tree, @aura/* packages), then the app's own entrypoint.
      return ['bash', '-c', RAW_START_SHELL, 'aura-raw', entrypointPath];
    }
    if (entrypointExists) return ['bash', entrypointPath];
    return ['bash', '-c', SYNTHESISED_ENTRYPOINT];
  }

  /**
   * Probe /api/lifecycle/health until the app responds AND its declared
   * identity matches what we just spawned. Identity match guards against the
   * "another app squatting our port" failure mode that caused the wrong-
   * content bug — a bare 200 is no longer enough.
   *
   * The probe carries the lifecycle token, so it goes out only once the
   * listener on the port is proven to belong to the spawned process tree
   * (`listenerOwnership`). A listener that belongs to anyone else fails the
   * start; so does a port whose owner can't be read.
   */
  private async waitHealthy(
    instanceId: string, appId: string, port: number,
    exited: () => string | null = () => null,
  ): Promise<HealthIdentityClass> {
    // See ContainerRunner.waitHealthy — a cold app installs its dependency
    // tree in the entrypoint, which must not be timed with the boot budget.
    const startedAt    = Date.now();
    const hardDeadline = startedAt + PROVISION_TIMEOUT_MS;
    const provision    = this.processes.get(instanceId)?.provision;
    let   deadline     = startedAt + HEALTH_CHECK_TIMEOUT_MS;
    const healthUrl = this.lifecycleUrl(port, 'health');
    const spawned = this.processes.get(instanceId);
    let lastBody: string | null = null;
    while (Date.now() < deadline) {
      const exit = exited();
      if (exit) {
        throw new StartupFailure(`[ProotRunner] ${instanceId} exited during startup (${exit}) before answering on port ${port}`);
      }
      // Nothing listens yet: keep waiting. Someone else listens: the port is
      // poisoned, fail loud. Only our own listener gets the token.
      const owner = spawned ? listenerOwnership(port, spawned.process.pid) : 'unknown';
      if (owner === 'foreign' || owner === 'unknown') {
        throw new DestinationBindingError(
          `[ProotRunner] ${instanceId} on port ${port}: ` + (owner === 'foreign'
            ? 'the listener does not belong to the spawned process tree. Another process is likely squatting this port.'
            : 'cannot confirm that the listener belongs to the spawned process tree.'),
        );
      }
      if (owner === 'own') {
        try {
          const res = await fetch(healthUrl, { headers: lifecycleHeaders(spawned!.lifecycleToken), signal: AbortSignal.timeout(1000) });
          if (res.ok) {
            const text = await res.text();
            lastBody = text;
            const identity = classifyHealthIdentity(text, appId, instanceId);
            const refusal = healthIdentityRefusal(identity, appId, instanceId);
            // Port poisoned or identity required — fail loud, no point waiting.
            if (refusal) throw new DestinationBindingError(`[ProotRunner] ${refusal} on port ${port}.`);
            if (identity.kind === 'legacy') console.warn(`[ProotRunner] ${instanceId} health endpoint returned no identity body; admitted as a known legacy app (warn mode).`);
            return identity.kind;
          }
        } catch (err) {
          if (err instanceof DestinationBindingError) throw err;
          // Otherwise keep polling (connection refused, etc.)
        }
      }
      deadline = nextHealthDeadline({
        now: Date.now(), deadline, hardDeadline,
        isProvisioning: provision?.isProvisioning ?? false,
        bootBudgetMs:   HEALTH_CHECK_TIMEOUT_MS,
      });
      await sleep(HEALTH_CHECK_INTERVAL_MS);
    }
    const waited = Math.round((Date.now() - startedAt) / 1000);
    throw new StartupFailure(
      provision?.everProvisioned
        ? `[ProotRunner] ${instanceId} did not become healthy ${waited}s after starting to install its dependencies (last body: ${lastBody ?? 'none'})`
        : `[ProotRunner] ${instanceId} did not become healthy within ${HEALTH_CHECK_TIMEOUT_MS}ms (last body: ${lastBody ?? 'none'})`,
    );
  }

  /** `http://localhost:<port>/api/lifecycle/<hook>` — PRoot apps share the shell's network. */
  private lifecycleUrl(port: number, hook: string): string {
    return `http://localhost:${port}${lifecyclePath(hook)}`;
  }

  /**
   * The instance, if the listener on its port still belongs to its process
   * tree — checked before every call that carries the lifecycle token.
   */
  private boundInstance(instanceId: string): SpawnedApp | null {
    const spawned = this.processes.get(instanceId);
    if (!spawned) return null;
    const owner = listenerOwnership(spawned.port, spawned.process.pid);
    if (owner === 'own') return spawned;
    console.warn(`[ProotRunner] ${instanceId}: listener on port ${spawned.port} is ${owner}; lifecycle call not sent`);
    return null;
  }

  async callLifecycle(instanceId: string, hook: string, opts: { reason?: string } = {}): Promise<void> {
    if (!this.processes.has(instanceId)) throw new Error(`[ProotRunner] ${instanceId} is not running`);
    const spawned = this.boundInstance(instanceId);
    if (!spawned) throw new Error(`[ProotRunner] ${instanceId}: port ${this.processes.get(instanceId)?.port} is not bound to the instance; ${hook} not sent`);
    const res = await fetch(this.lifecycleUrl(spawned.port, hook), {
      method: 'POST',
      headers: lifecycleHeaders(spawned.lifecycleToken, opts.reason ? { 'x-aura-stop-reason': opts.reason } : {}),
      signal: AbortSignal.timeout(LIFECYCLE_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`[ProotRunner] ${instanceId} lifecycle hook ${hook} returned ${res.status}`);
    }
  }

  /**
   * Call an OPTIONAL lifecycle hook on the app. Returns the response body
   * (parsed JSON) on success, or null when the app returns 404 or fails to respond.
   * Used for `onSubprocessCreate` / `onSubprocessDestroy` — apps that don't care
   * about subprocesses just don't implement these routes.
   */
  async callOptionalLifecycle(
    instanceId: string,
    hook: string,
    body?: unknown,
  ): Promise<unknown | null> {
    const spawned = this.boundInstance(instanceId);
    if (!spawned) return null;
    try {
      const res = await fetch(this.lifecycleUrl(spawned.port, hook), {
        method: 'POST',
        headers: lifecycleHeaders(spawned.lifecycleToken, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(LIFECYCLE_TIMEOUT_MS),
      });
      if (res.status === 404 || !res.ok) return null;
      const text = await res.text();
      if (!text) return null;
      try { return JSON.parse(text); } catch { return text; }
    } catch {
      return null;
    }
  }

  async kill(instanceId: string): Promise<void> {
    const spawned = this.processes.get(instanceId);
    if (!spawned) return;
    this.processes.delete(instanceId);
    // Detach all exit listeners so an intentional kill doesn't trigger
    // the AppManager's unexpected-exit → 'error' transition.
    spawned.process.removeAllListeners('exit');
    killProcessGroup(spawned.process.pid, 'SIGTERM');
    await sleep(5000).catch(() => undefined);
    if (!spawned.process.killed) killProcessGroup(spawned.process.pid, 'SIGKILL');
  }

  /** Immediate SIGKILL without grace period — for force-kill from process manager. */
  forceKill(instanceId: string): boolean {
    const spawned = this.processes.get(instanceId);
    if (!spawned) return false;
    this.processes.delete(instanceId);
    spawned.process.removeAllListeners('exit');
    killProcessGroup(spawned.process.pid, 'SIGKILL');
    return true;
  }

  /** The instance's output ring (SandboxRunner `outputLog`). */
  outputLog(instanceId: string): OutputLog | null {
    return this.outputs.get(instanceId) ?? null;
  }

  /**
   * PRoot apps run in the same network namespace as the shell, so they're
   * always reachable at 127.0.0.1. Returns null for unknown instances so
   * callers can distinguish "not tracked" from "tracked but no host".
   */
  getHost(instanceId: string): string | null {
    return this.processes.has(instanceId) ? '127.0.0.1' : null;
  }

  getPort(instanceId: string): number | null {
    return this.processes.get(instanceId)?.port ?? null;
  }

  lifecycleStatus(instanceId: string): LifecycleStatus | null {
    return this.processes.get(instanceId)?.lifecycle ?? null;
  }

  /** D89 B4: the relay claim key of this start (from its lifecycle token), or null without one. */
  relayKey(instanceId: string): Buffer | null {
    const token = this.processes.get(instanceId)?.lifecycleToken;
    return token ? relayKey(token) : null;
  }

  /**
   * Run `argv` in the instance's sandbox: a sibling proot with the same
   * identity, binds, env and cwd it was launched with (so the same tools at
   * /aura/my-tools and the same HOME).
   */
  async exec(instanceId: string, argv: string[], opts: SandboxExecOpts = {}): Promise<{ stdout: string; stderr: string }> {
    const p = this.processes.get(instanceId);
    if (!p || !argv.length) throw new Error(`${instanceId} is not running in PRoot`);
    const { command, prefix, env, appDir } = p.launch;
    return execFileAsync(command, [...prefix, ...argv], {
      cwd: appDir, env: { ...env, ...opts.env },
      timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024,
    });
  }

  isRunning(instanceId: string): boolean {
    return this.processes.has(instanceId);
  }

  /**
   * Every PID we've spawned (whether or not waitHealthy has finished). The
   * reconciler reads this — not just AppManager.instances[].pid — because
   * during the 0..30s waitHealthy window, the instance entry's `pid` is still
   * null even though the proot is live. Without this view the orphan reaper
   * would kill the new instance's proot/astro before it ever became healthy.
   */
  getActivePids(): number[] {
    const out: number[] = [];
    for (const s of this.processes.values()) {
      if (s.process.pid != null) out.push(s.process.pid);
    }
    return out;
  }

  onExit(instanceId: string, cb: (code: number | null) => void): void {
    this.processes.get(instanceId)?.process.on('exit', cb);
  }
}

/**
 * The app did not come up: it exited while booting or never answered its
 * health check. Distinct from an identity mismatch (someone else owns the
 * port), which a retry in another serve mode can't fix.
 */
export class StartupFailure extends Error {}

/** The last few KB of an app's output, for the startup-failure log. */
export class OutputTail {
  private chunks: string[] = [];
  private size = 0;
  constructor(private readonly max = 4096) {}
  push(text: string): void {
    this.chunks.push(text);
    this.size += text.length;
    while (this.size > this.max && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
  }
  text(): string {
    return this.chunks.join('').slice(-this.max).trimEnd();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The port's listener does not belong to the instance just started (or that
 * can't be confirmed), or its health identity is refused. A retry in another
 * serve mode can't fix either.
 */
export class DestinationBindingError extends Error {}

export type ListenerOwnership = 'none' | 'own' | 'foreign' | 'unknown';

/**
 * Who listens on TCP `port` in this network namespace (the one PRoot apps
 * share with the shell): `own` when every listening socket on the port is an
 * open fd of a process in the tree rooted at `rootPid` (its descendants, or
 * members of its session — the spawn is `detached`, so it leads one), `none`
 * when nothing listens yet, `foreign` when any listener belongs to another
 * process, `unknown` when /proc can't tell.
 */
export function listenerOwnership(port: number, rootPid: number | undefined, procRoot = '/proc'): ListenerOwnership {
  if (!rootPid) return 'unknown';
  const listening = new Set<string>();
  let readAny = false;
  for (const file of ['net/tcp', 'net/tcp6']) {
    let text: string;
    try { text = readFileSync(`${procRoot}/${file}`, 'utf-8'); readAny = true; } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      // sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode
      if (f.length < 10 || f[3] !== '0A') continue;
      if (parseInt(f[1]!.split(':')[1] ?? '', 16) === port) listening.add(f[9]!);
    }
  }
  if (!readAny) return 'unknown';
  if (listening.size === 0) return 'none';
  const tree = processTree(rootPid, procRoot);
  if (!tree) return 'unknown';
  const owned = new Set<string>();
  for (const pid of tree) {
    let fds: string[];
    try { fds = readdirSync(`${procRoot}/${pid}/fd`); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;   // exited meanwhile
      return 'unknown';
    }
    for (const fd of fds) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`${procRoot}/${pid}/fd/${fd}`));
        if (m) owned.add(m[1]!);
      } catch { /* fd closed meanwhile */ }
    }
  }
  for (const inode of listening) if (!owned.has(inode)) return 'foreign';
  return 'own';
}

/** `rootPid`, its descendants and its session's members, from /proc/<pid>/stat. */
function processTree(rootPid: number, procRoot: string): Set<number> | null {
  let entries: string[];
  try { entries = readdirSync(procRoot); } catch { return null; }
  const children = new Map<number, number[]>();
  const tree = new Set<number>([rootPid]);
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try { stat = readFileSync(`${procRoot}/${name}/stat`, 'utf-8'); } catch { continue; }
    // pid (comm) state ppid pgrp session … — comm may hold spaces and parens.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const pid = Number(name);
    const ppid = Number(rest[1]);
    if (Number(rest[3]) === rootPid) tree.add(pid);
    const list = children.get(ppid);
    if (list) list.push(pid); else children.set(ppid, [pid]);
  }
  const queue = [...tree];
  while (queue.length) {
    for (const c of children.get(queue.pop()!) ?? []) if (!tree.has(c)) { tree.add(c); queue.push(c); }
  }
  return tree;
}

/**
 * Signal an entire process group, not just the spawned root. Required because
 * apps spawn `bash entrypoint.sh` which spawns `astro dev` which may further
 * detach — sending SIGTERM/SIGKILL only to the proot pid leaves orphan astros
 * that then squat the released port. With `detached: true` on spawn() the
 * child's pid is also its process-group id, so `kill(-pid, sig)` reaches
 * every descendant.
 *
 * Falls back to single-pid kill if pid is missing or already gone.
 */
export function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (err) {
    // ESRCH = group already gone; EPERM is unusual but harmless — try the
    // single-pid path so we don't silently leak.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return;
    try { process.kill(pid, signal); } catch { /* really gone */ }
  }
}
