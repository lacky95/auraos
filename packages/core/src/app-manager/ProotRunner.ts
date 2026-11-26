import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AppManifest } from '../types/manifest.js';
import { lifecyclePath } from '../types/manifest.js';
import { ALL_TOOLS_PATH, MY_TOOLS_PATH, currentToolsMode, provisionAllowlist } from './tool-provision.js';
import { PROOT_HOME_ENV, prootHomeBind } from './spawn/homeArgs.js';
import { prootContextBinds } from './spawn/contextArgs.js';
import { prootSocketBinds } from './spawn/socketArgs.js';
import type { RuntimeCapabilities } from '../runtimes/types.js';
import type { SandboxExecOpts, SandboxRunner, SandboxRunnerOpts } from './SandboxRunner.js';
import { OutputLog } from './outputLog.js';
import type { SpawnContext } from '../scopes/types.js';
import { ContextStore } from '../context/ContextStore.js';
import { VolumeStore, type VolumeEntry } from '../context/VolumeStore.js';
import {
  ASTRO_START_SHELL, RAW_START_SHELL, PROVISION_TIMEOUT_MS, ProvisionWatch, nextHealthDeadline,
} from './provisioning.js';
import { serveState } from './appBuild.js';
import {
  checkHealthGuard, classifyHealthIdentity, healthIdentityRefusal, lifecycleHeaders, lifecycleStatusRefusal,
  newLifecycleToken, type HealthIdentityClass, type LifecycleStatus,
} from './lifecycleGate.js';

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

interface SpawnedApp {
  process: ChildProcess;
  /** Watches the app's output to tell "installing dependencies" from
   *  "failing to boot" — see provisioning.ts. */
  provision: ProvisionWatch;
  port: number;
  appId: string;
  /** How the instance was launched, so `exec` can join the same sandbox:
   *  the proot args minus the entrypoint (empty when not prooted), env, cwd. */
  launch: { prooted: boolean; sandboxArgs: string[]; env: Record<string, string>; appDir: string };
  /** This start's lifecycle secret (also `AURA_LIFECYCLE_TOKEN` in `launch.env`). */
  lifecycleToken: string;
  /** Health identity and runtime-check result, once healthy. */
  lifecycle?: LifecycleStatus;
}

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
  /** OS-wide env/secret store, injected into every sandbox. */
  private contextStore: ContextStore;
  /** OS-managed shared volumes, bound into every sandbox. */
  private volumeStore: VolumeStore;

  constructor(opts: SandboxRunnerOpts) {
    this.baseRootfs = opts.baseRootfs;
    this.toolchainDir = opts.toolchainDir;
    this.appsDir = opts.appsDir;
    this.dataDir = opts.dataDir;
    this.osApiBase = opts.osApiBase;
    this.contextStore = new ContextStore(opts.dataDir);
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

  /**
   * Today's PRoot runtime on the master (ARI §2.3): ptrace isolation, no
   * enforced read-only binds (ARI-4), no mounts, port expose or sidecars, and
   * its processes die with the shell. Never a Private Home boundary (D65).
   */
  public capabilities(): RuntimeCapabilities {
    return {
      isolation: 'ptrace',
      privateHomeSession: false,
      sessionExec: false,
      identity: 'none',
      readOnlyBinds: false,
      mounts: false,
      portExpose: false,
      sidecars: false,
      warmPool: true,
      survivesShellRestart: false,
    };
  }

  /**
   * Recreate the per-instance allowlist so it holds exactly the binaries this
   * app's `tools[]` grants — hardlinks from the toolchain mirror by default,
   * symlinks into /aura/all-tools on filesystems that can't hardlink. See
   * tool-provision.ts for the two modes and why the mode decides whether
   * buildProotArgs also binds the shared store.
   *
   * Apps with `'*'` in tools[] get every entry in the toolchain; explicit-list
   * apps get just their declared tools (with the historical `claude-code` →
   * `claude` rename preserved). Called once at spawn AND on cap
   * grant/revoke/install for live instances — so a running terminal sees a new
   * capability appear in PATH without a respawn.
   */
  public provisionToolsDir(instanceId: string, manifest: AppManifest): string {
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

  async spawn(instanceId: string, appId: string, port: number, manifest: AppManifest, ctx: SpawnContext): Promise<number> {
    const appDir = ctx.appDir;
    const dataDir = ctx.instanceDataDir;

    const useProotEnv = process.env['AURA_USE_PROOT'];
    // Two-level opt-out: the OS-wide env var, then the per-app manifest flag.
    // useProot defaults to true; an app sets `"useProot": false` when its
    // native deps (Tailwind 4 Oxide, etc.) hit PRoot's ptrace EFAULT bug.
    const prooted = useProotEnv === 'true'
                 && manifest.useProot !== false
                 && existsSync(this.baseRootfs);
    // Resolve once — used by the proot-args builder AND (when not prooted) as
    // the direct spawn argv.
    const entrypointArgv = this.resolveEntrypoint(appDir, manifest);
    // Materialise the per-instance tool allowlist BEFORE building the args
    // (the args reference the dir). Wildcard apps get the whole store mirrored;
    // explicit apps get just their declared tools.
    if (prooted) this.provisionToolsDir(instanceId, manifest);
    // Resolve OS Context (env/secret) LIVE from Valkey on every spawn.
    this.contextStore.ensureDir();
    const contextEnv = await this.contextStore.resolveEnv();
    // OS-managed shared volumes — bound into the proot (RW; proot --bind can't
    // enforce read-only, so RO volumes are effectively RW here).
    await this.volumeStore.ensureAll();
    const contextVolumes = await this.volumeStore.resolveMounts();
    const args = this.buildProotArgs(instanceId, port, manifest, appDir, dataDir, prooted, entrypointArgv, contextVolumes);

    // Prepend the per-instance allowlist to PATH so non-interactive children
    // (which don't source .bashrc) still find granted tools. Interactive
    // shells also benefit — the bashrc's PATH guard then short-circuits.
    const inheritedPath = process.env['PATH'] ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    const path = prooted ? `${MY_TOOLS_PATH}:${inheritedPath}` : inheritedPath;
    // The granted tools' shared libraries need no env var here: tools with
    // staged libs are wrapper scripts that scope LD_LIBRARY_PATH to their own
    // process tree (see provisionAllowlist), and `cap install` also stages
    // libs into base-rootfs at their original paths (which survives an exec
    // that scrubs the environment, e.g. sudo). A process-wide LD_LIBRARY_PATH
    // would shadow newer copies of the same sonames in the app's own runtime.
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      // OS Context env FIRST — the fixed OS vars below override, so a context
      // key can't clobber PATH/APP_ID/OS_API_BASE etc.
      ...contextEnv,
      PATH: path,
      // Apps get the USER's home, never the master's. Prooted apps reach it
      // through the bind in buildProotArgs; non-prooted apps run inside the
      // master container, where /home/aura is a symlink to the same dir (see
      // Dockerfile). Set unconditionally — inheriting the master's $HOME here
      // would leak OS-operator state into an app and write app state into it.
      HOME: PROOT_HOME_ENV,
      APP_ID: appId,
      APP_INSTANCE_ID: instanceId,
      APP_PORT: String(port),
      OS_API_BASE: this.osApiBase,
      // prod = start from the app's build (matches its sources), dev = astro
      // dev; read by ASTRO_START_SHELL (appBuild.ts serveState).
      AURA_SERVE: serveState(ctx.appDir, manifest).mode,
      // Statically known: AppManager runs inside the Docker container and
      // every spawn we do is wrapped in PRoot. Baking the tag here means the
      // /root/.bashrc snippet that renders the prompt never has to shell out
      // to detect layers — saves ~100–300 ms off every interactive terminal
      // launch (which is dominated by bash startup work, not by anything we
      // can fix in pty-server or astro).
      // Drop the "proot" half of the layer tag when the app opted out of
      // PRoot (the prompt should reflect the actual sandbox state, not the
      // OS-wide intent). Bash startup .bashrc reads $AURA_LAYER_TAG verbatim.
      AURA_LAYER_TAG: prooted ? '[proot+ctnr]' : '[ctnr]',
      // Same bearer ContainerRunner injects. The token-gated sidecar routes
      // still answer 409 for proot sandboxes; carrying it keeps identity
      // uniform across runners.
      ...(ctx.instanceToken ? { AURA_INSTANCE_TOKEN: ctx.instanceToken.token } : {}),
      // Per-start shell→app secret for the lifecycle routes (lifecycleGate.ts).
      AURA_LIFECYCLE_TOKEN: newLifecycleToken(),
    };

    try {
      return await this.startProcess(instanceId, appId, port, manifest, args, appDir, env, prooted, entrypointArgv);
    } catch (err) {
      // A production build that won't boot (it exits, or never answers) must
      // not leave the app dead: the sources are right there, so `astro dev`
      // is a working fallback. Store-installed apps hit this first — their
      // build was made on this machine and nobody watched it boot.
      if (env['AURA_SERVE'] !== 'prod' || !(err instanceof StartupFailure)) throw err;
      console.warn(`[ProotRunner] ${instanceId}: production build failed to start — retrying with astro dev`);
      return await this.startProcess(instanceId, appId, port, manifest, args, appDir, { ...env, AURA_SERVE: 'dev' }, prooted, entrypointArgv);
    }
  }

  /** Spawn the sandbox once and wait until it is healthy, or fail loud. */
  private async startProcess(
    instanceId: string, appId: string, port: number, manifest: AppManifest,
    args: string[], appDir: string, env: Record<string, string>,
    prooted: boolean, entrypointArgv: string[],
  ): Promise<number> {
    console.log(`[ProotRunner] Spawning ${instanceId} (app=${appId}) on port ${port} (serve=${env['AURA_SERVE']})`);

    // detached: true makes proot a process-group leader so we can SIGKILL the
    // entire group on cleanup (including any detached astro children). Without
    // it, kill() only signals the proot pid and orphan astros survive on the
    // bound port — that's the squatter that caused the wrong-content bug.
    const child = spawn(
      prooted ? 'proot'          : entrypointArgv[0]!,
      prooted ? args             : entrypointArgv.slice(1),
      { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );

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

    const sandboxArgs = prooted ? args.slice(0, args.length - entrypointArgv.length) : [];
    const spawned: SpawnedApp = {
      process: child, port, appId, provision,
      launch: { prooted, sandboxArgs, env, appDir },
      lifecycleToken: env['AURA_LIFECYCLE_TOKEN']!,
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

  private buildProotArgs(
    instanceId: string,
    port: number,
    manifest: AppManifest,
    appDir: string,
    dataDir: string,
    useProot: boolean,
    entrypointArgv: string[],
    contextVolumes: VolumeEntry[] = [],
  ): string[] {
    if (!useProot) return entrypointArgv;

    // pnpm workspace creates node_modules as a forest of relative symlinks
    // (e.g. `node_modules/astro → ../../node_modules/.pnpm/astro@.../astro`).
    // Those resolve correctly ONLY if the app dir keeps its `/workspace/apps/<id>`
    // absolute path inside the PRoot. We therefore drop the `/app` alias and
    // use the workspace path as cwd; `APP_ID`/`APP_INSTANCE_ID` env vars give
    // the app its identity instead.
    const args = [
      `--rootfs=${this.baseRootfs}`,
      '--bind=/workspace:/workspace',
      `--bind=${dataDir}:/data`,
      '--bind=/proc',
      '--bind=/dev',
      '--bind=/tmp',
      '--bind=/etc/resolv.conf:/etc/resolv.conf',
      // Bring the master container's Node 22 into the sandbox — Debian-bookworm
      // ships Node 18 in its package archive, which is too old for our apps.
      '--bind=/usr/local/bin/node:/usr/local/bin/node',
      // The user's HOME — the SAME `aura/home/<userId>` dir ContainerRunner
      // mounts at /home/aura in every app container (spawn/homeArgs.ts). (The
      // master container's own home is deliberately elsewhere — see
      // scopes/home.ts.) Without this bind a PRoot's HOME resolves inside the
      // base-rootfs (/os/base-rootfs/root), which is an IMAGE LAYER: every
      // `claude` login, `gh auth`, ssh key and tool dotfile written there is
      // destroyed by the next `compose up --build` or container recreate.
      prootHomeBind({ dataDir: this.dataDir }),
      // OS Context: /run/context and the shared Context Volumes (spawn/contextArgs.ts).
      ...prootContextBinds({ systemDir: this.contextStore.systemDir, volumesDir: this.volumeStore.volumesDir, volumes: contextVolumes }),
      // Expose the app's own source dir at its real absolute path. Required for
      // user/global-scope apps, whose appDir lives UNDER /data (e.g.
      // /data/scopes/users/<u>/apps/<id>): the `${dataDir}:/data` bind above
      // remaps /data to the per-instance data dir, which would otherwise shadow
      // the app source — `chdir(appDir)` then fails and proot falls back to `/`,
      // so `astro dev` never finds package.json/node_modules. Binding appDir
      // onto itself overlays that subtree back. For system-scope apps (appDir
      // under /workspace) this is a no-op — the path already maps to the same
      // host dir via the /workspace bind.
      `--bind=${appDir}:${appDir}`,
      `--cwd=${appDir}`,
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
    const toolBinDir = join(this.toolchainDir, 'bin');
    if (existsSync(toolBinDir)) {
      const myTools = this.toolsDir(instanceId);
      mkdirSync(myTools, { recursive: true });
      if (currentToolsMode(this.dataDir) === 'symlink') {
        args.push(`--bind=${toolBinDir}:${ALL_TOOLS_PATH}`);
      }
      args.push(`--bind=${myTools}:${MY_TOOLS_PATH}`);
    }

    // The Docker socket when `tools[]` grants `docker` (spawn/socketArgs.ts).
    args.push(...prootSocketBinds(manifest.tools));

    args.push(...entrypointArgv);
    return args;
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

  /**
   * Run `argv` in the instance's sandbox: a sibling proot with the same binds,
   * env and cwd it was launched with (so the same tools at /aura/my-tools and
   * the same HOME), or — not prooted — a plain process with that env.
   */
  async exec(instanceId: string, argv: string[], opts: SandboxExecOpts = {}): Promise<{ stdout: string; stderr: string }> {
    const p = this.processes.get(instanceId);
    if (!p || !argv.length) throw new Error(`${instanceId} is not running in PRoot`);
    const { prooted, sandboxArgs, env, appDir } = p.launch;
    const [cmd, args] = prooted ? ['proot', [...sandboxArgs, ...argv]] : [argv[0]!, argv.slice(1)];
    return execFileAsync(cmd, args, {
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
