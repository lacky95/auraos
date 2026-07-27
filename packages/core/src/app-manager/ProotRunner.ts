import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AppManifest } from '../types/manifest.js';
import { lifecyclePath } from '../types/manifest.js';
import { toolsGrant } from './tool-allowlist.js';
import { ALL_TOOLS_PATH, MY_TOOLS_PATH, currentToolsMode, provisionAllowlist } from './tool-provision.js';
import type { SandboxRunner, SandboxRunnerOpts } from './SandboxRunner.js';
import type { SpawnContext } from '../scopes/types.js';
import { ContextStore } from '../context/ContextStore.js';

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
const SYNTHESISED_ENTRYPOINT = `set -e
export PORT="\${APP_PORT:-4001}"
# Resolve astro. System-scope apps inherit it from the workspace's hoisted
# /workspace/node_modules/.bin/astro. User/global-scope apps live outside
# the pnpm workspace; they have to install astro into their own
# node_modules. Run npm install only when neither path has astro yet.
if [ ! -x "node_modules/.bin/astro" ] && [ ! -x "/workspace/node_modules/.bin/astro" ]; then
  echo "[\${APP_ID:-app}] npm install (astro not yet present)..."
  npm install --prefer-offline 2>&1 || npm install
fi
# Pull @aura/* SDK packages from the local OCI registry when referenced in
# \`auraDependencies\` (user/global) or legacy \`dependencies\` and the
# workspace symlinks didn't materialise them. No-op when /workspace's
# pnpm install already populated /workspace/node_modules/@aura/*.
if [ ! -d node_modules/@aura ] && grep -qE '"(aura)?[dD]ependencies"|"@aura/' package.json 2>/dev/null; then
  command -v aura >/dev/null && aura sdk install --quiet || true
fi
ASTRO="node_modules/.bin/astro"
[ -x "\$ASTRO" ] || ASTRO="/workspace/node_modules/.bin/astro"
echo "[\${APP_ID:-app}] Starting Astro server on port \$PORT via \$ASTRO"
exec "\$ASTRO" dev --host 0.0.0.0 --port "\$PORT"`;

interface SpawnedApp {
  process: ChildProcess;
  port: number;
  appId: string;
  /**
   * Cached manifest snapshot used by lifecycle/health URL building. Stored
   * once at spawn so subsequent calls (`callLifecycle`, the reconciler probe)
   * don't have to re-fetch from the registry. Currently only the proxy.preservePrefix
   * flag matters; treated read-only after spawn.
   */
  manifest: AppManifest;
}

export class ProotRunner implements SandboxRunner {
  private processes = new Map<string, SpawnedApp>();
  private baseRootfs: string;
  private toolchainDir: string;
  private appsDir: string;
  private dataDir: string;
  private osApiBase: string;
  /** OS-wide env/secret store, injected into every sandbox. */
  private contextStore: ContextStore;

  constructor(opts: SandboxRunnerOpts) {
    this.baseRootfs = opts.baseRootfs;
    this.toolchainDir = opts.toolchainDir;
    this.appsDir = opts.appsDir;
    this.dataDir = opts.dataDir;
    this.osApiBase = opts.osApiBase;
    this.contextStore = new ContextStore(opts.dataDir);
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
    // Resolve OS Context (env/secret) LIVE from Redis on every spawn.
    this.contextStore.ensureDir();
    const contextEnv = await this.contextStore.resolveEnv();
    const args = this.buildProotArgs(instanceId, port, manifest, appDir, dataDir, prooted, entrypointArgv);

    // Prepend the per-instance allowlist to PATH so non-interactive children
    // (which don't source .bashrc) still find granted tools. Interactive
    // shells also benefit — the bashrc's PATH guard then short-circuits.
    const inheritedPath = process.env['PATH'] ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    const path = prooted ? `${MY_TOOLS_PATH}:${inheritedPath}` : inheritedPath;
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      // OS Context env FIRST — the fixed OS vars below override, so a context
      // key can't clobber PATH/APP_ID/OS_API_BASE etc.
      ...contextEnv,
      PATH: path,
      APP_ID: appId,
      APP_INSTANCE_ID: instanceId,
      APP_PORT: String(port),
      OS_API_BASE: this.osApiBase,
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
    };

    console.log(`[ProotRunner] Spawning ${instanceId} (app=${appId}) on port ${port}`);

    // detached: true makes proot a process-group leader so we can SIGKILL the
    // entire group on cleanup (including any detached astro children). Without
    // it, kill() only signals the proot pid and orphan astros survive on the
    // bound port — that's the squatter that caused the wrong-content bug.
    const child = spawn(
      prooted ? 'proot'          : entrypointArgv[0]!,
      prooted ? args             : entrypointArgv.slice(1),
      { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );

    child.stdout?.on('data', (d) => process.stdout.write(`[${instanceId}] ${d}`));
    child.stderr?.on('data', (d) => process.stderr.write(`[${instanceId}] ${d}`));

    this.processes.set(instanceId, { process: child, port, appId, manifest });

    try {
      await this.waitHealthy(instanceId, appId, port, manifest);
    } catch (err) {
      // Either timeout or identity mismatch — clean up the partial spawn so we
      // don't leak an orphan process or a stale instance entry. Caller is
      // responsible for releasing the port.
      console.error(`[ProotRunner] ${instanceId} health-check failed: ${(err as Error).message}`);
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
   *     the form of a hung health check.
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
      return ['bash', entrypointPath];
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
      // OS Context files. The master writes decrypted values here; binding the
      // dir at /run/context mirrors changes live (no respawn to pick up a file
      // edit — mirrors the ContainerRunner volume-subpath mount).
      `--bind=${this.contextStore.systemDir}:/run/context`,
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

    // Bind the host docker socket if the manifest asks for it (explicit
    // 'docker' in tools[] or the wildcard '*' allowlist). Required so that
    // `docker` invocations from inside the proot — e.g. `aura jump` from
    // the terminal app dropping into a sibling-container app via
    // `docker exec` — reach the same daemon the shell uses.
    const wantsDocker = toolsGrant(manifest.tools ?? [], 'docker');
    if (wantsDocker && existsSync('/var/run/docker.sock')) {
      args.push('--bind=/var/run/docker.sock:/var/run/docker.sock');
    }

    args.push(...entrypointArgv);
    return args;
  }

  /**
   * Probe /api/lifecycle/health until the app responds AND its declared
   * identity matches what we just spawned. Identity match guards against the
   * "another app squatting our port" failure mode that caused the wrong-
   * content bug — a bare 200 is no longer enough.
   */
  private async waitHealthy(instanceId: string, appId: string, port: number, manifest: AppManifest): Promise<void> {
    const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;
    const healthUrl = `http://localhost:${port}${lifecyclePath(manifest, instanceId, 'health')}`;
    let lastBody: string | null = null;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          const text = await res.text();
          lastBody = text;
          const verdict = verifyHealthIdentity(text, appId, instanceId);
          if (verdict.kind === 'match') return;
          if (verdict.kind === 'legacy') {
            console.warn(`[ProotRunner] ${instanceId} health endpoint returned no identity body; accepting on legacy fallback.`);
            return;
          }
          // Mismatch — port poisoned, fail loud.
          throw new Error(
            `[ProotRunner] ${instanceId} on port ${port}: health identity mismatch ` +
            `(expected appId=${appId} instanceId=${instanceId}, got appId=${verdict.claimedApp} instanceId=${verdict.claimedInstance}). ` +
            `Another process is likely squatting this port.`
          );
        }
      } catch (err) {
        // Re-throw identity mismatch immediately — port is poisoned, no point waiting.
        if (err instanceof Error && err.message.includes('identity mismatch')) throw err;
        // Otherwise keep polling (connection refused, etc.)
      }
      await sleep(HEALTH_CHECK_INTERVAL_MS);
    }
    throw new Error(`[ProotRunner] ${instanceId} did not become healthy within ${HEALTH_CHECK_TIMEOUT_MS}ms (last body: ${lastBody ?? 'none'})`);
  }

  async callLifecycle(instanceId: string, hook: string): Promise<void> {
    const spawned = this.processes.get(instanceId);
    if (!spawned) throw new Error(`[ProotRunner] ${instanceId} is not running`);
    const url = `http://localhost:${spawned.port}${lifecyclePath(spawned.manifest, instanceId, hook)}`;
    const res = await fetch(url, {
      method: 'POST',
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
    const spawned = this.processes.get(instanceId);
    if (!spawned) return null;
    try {
      const res = await fetch(`http://localhost:${spawned.port}${lifecyclePath(spawned.manifest, instanceId, hook)}`, {
        method: 'POST',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type IdentityVerdict =
  | { kind: 'match' }
  | { kind: 'legacy' }
  | { kind: 'mismatch'; claimedApp: string | null; claimedInstance: string | null };

/**
 * Parse a `/api/lifecycle/health` response body and decide whether the
 * upstream owner is who we expect. Pulled out of `waitHealthy` so the
 * regression test can exercise the contract directly without spawning
 * real processes.
 *
 * - `match`    : body identity matches both expected appId and instanceId.
 * - `legacy`   : body has no identity fields at all (older app template) —
 *                accepted with a warning during rollout.
 * - `mismatch` : body identifies a different app/instance — fail loud.
 */
export function verifyHealthIdentity(
  rawBody: string,
  expectedAppId: string,
  expectedInstanceId: string,
): IdentityVerdict {
  let body: { appId?: unknown; instanceId?: unknown } = {};
  try { body = JSON.parse(rawBody) as typeof body; } catch { /* tolerate non-JSON / legacy */ }
  const claimedApp      = typeof body.appId      === 'string' ? body.appId      : null;
  const claimedInstance = typeof body.instanceId === 'string' ? body.instanceId : null;
  if (claimedApp === null && claimedInstance === null) return { kind: 'legacy' };
  if (claimedApp === expectedAppId && claimedInstance === expectedInstanceId) return { kind: 'match' };
  return { kind: 'mismatch', claimedApp, claimedInstance };
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
