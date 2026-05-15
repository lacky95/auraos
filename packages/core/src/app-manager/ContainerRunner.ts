import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { AppManifest } from '../types/manifest.js';
import type { SandboxRunner, SandboxRunnerOpts } from './SandboxRunner.js';

const HEALTH_CHECK_INTERVAL_MS = 200;
const HEALTH_CHECK_TIMEOUT_MS = 60_000; // slightly higher than PRoot because container spawn adds ~100 ms
const LIFECYCLE_TIMEOUT_MS = 5_000;
const SHARED_NETWORK = process.env['AURA_DOCKER_NETWORK'] ?? 'aura-net';
const BASE_IMAGE     = process.env['AURA_BASE_IMAGE']     ?? 'aura-base';

const SYNTHESISED_ENTRYPOINT = `set -e
export PORT="\${APP_PORT:-4001}"
if [ ! -d node_modules ]; then
  echo "[\${APP_ID:-app}] Installing dependencies..."
  npm install --prefer-offline 2>&1 || npm install
fi
echo "[\${APP_ID:-app}] Starting Astro server on port \$PORT"
exec node_modules/.bin/astro dev --host 0.0.0.0 --port "\$PORT"`;

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

  constructor(opts: SandboxRunnerOpts) {
    this.toolchainDir = opts.toolchainDir;
    this.appsDir      = opts.appsDir;
    this.dataDir      = opts.dataDir;
    this.osApiBase    = opts.osApiBase;
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
  }

  // ─── Tool-allowlist dir (shared semantics with PRoot) ─────────────────
  public toolsDir(instanceId: string): string {
    return join(this.dataDir, 'aura', 'runtime', instanceId, 'tools');
  }
  public provisionToolsDir(instanceId: string, manifest: AppManifest): string {
    const dir = this.toolsDir(instanceId);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    mkdirSync(dir, { recursive: true });
    const toolBinDir = join(this.toolchainDir, 'bin');
    const useWildcard = manifest.tools.includes('*');
    const entries = useWildcard
      ? (existsSync(toolBinDir) ? readdirSync(toolBinDir) : [])
      : manifest.tools.filter((t) => t !== '*');
    for (const tool of entries) {
      const binaryName = tool === 'claude-code' ? 'claude' : tool;
      try { symlinkSync(`/aura/all-tools/${binaryName}`, join(dir, binaryName)); } catch { /* dupe */ }
    }
    return dir;
  }
  public clearToolsDir(instanceId: string): void {
    try { rmSync(this.toolsDir(instanceId), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // ─── Spawn ────────────────────────────────────────────────────────────
  async spawn(instanceId: string, appId: string, port: number, manifest: AppManifest): Promise<number> {
    this.provisionToolsDir(instanceId, manifest);

    const hostname = this.containerName(instanceId);
    // Remove any stale container with the same name (orphaned by a previous
    // crash); --rm would have cleaned a normal exit, but `kill -9` of the
    // shell can leave them behind.
    try { execSync(`docker rm -f ${hostname}`, { stdio: 'ignore', timeout: 5_000 }); } catch { /* didn't exist */ }

    const args = this.buildDockerArgs(instanceId, appId, port, manifest, hostname);
    console.log(`[ContainerRunner] Spawning ${hostname} (app=${appId}) on port ${port}`);

    let containerId: string;
    try {
      containerId = execSync(`docker ${args.join(' ')}`, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
        .toString().trim();
    } catch (err) {
      throw new Error(`docker run failed for ${instanceId}: ${(err as Error).message}`);
    }
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

    const tracked: TrackedContainer = { containerId, hostname, port, appId, logTail, pid, exitCb: null };
    this.containers.set(instanceId, tracked);

    // Watch for container exit so we can fire the exit callback.
    const watcher = spawn('docker', ['wait', containerId], { stdio: ['ignore', 'pipe', 'ignore'] });
    watcher.stdout?.on('data', (d: Buffer) => {
      const code = parseInt(d.toString().trim(), 10);
      this.handleExit(instanceId, isNaN(code) ? null : code);
    });
    watcher.on('error', () => this.handleExit(instanceId, null));

    try {
      await this.waitHealthy(instanceId, appId, hostname, port);
    } catch (err) {
      console.error(`[ContainerRunner] ${instanceId} health-check failed: ${(err as Error).message}`);
      this.forceKill(instanceId);
      throw err;
    }
    return pid;
  }

  /** Build the `docker run` argv mirroring ProotRunner's bind topology. */
  private buildDockerArgs(
    instanceId: string,
    appId: string,
    port: number,
    manifest: AppManifest,
    hostname: string,
  ): string[] {
    const appDir       = `${this.workspaceRoot}/apps/${appId}`;
    const instDataDir  = join(this.dataDir, 'apps', appId, instanceId);
    const myTools      = this.toolsDir(instanceId);
    const toolBinDir   = join(this.toolchainDir, 'bin');
    mkdirSync(instDataDir, { recursive: true });

    const entrypoint = this.resolveEntrypoint(appId, manifest);

    // SLICED bind set — only this app's apps/<id> dir is visible at
    // /workspace/apps, with shared workspace dirs (node_modules, packages,
    // pnpm lockfiles) mounted alongside so pnpm symlinks resolve. Sibling
    // apps are genuinely invisible — `cd /workspace/apps` shows ONLY this
    // app's folder.
    const a: string[] = [
      'run', '--rm', '-d',
      '--name', hostname,
      '--hostname', hostname,
      '--network', SHARED_NETWORK,
      '--workdir', `/workspace/apps/${appId}`,
      // Per-app slice of /workspace. Each volume mount counts as its own
      // mount point in the container, so sibling apps in apps/<other> are
      // not reachable — there's no parent /workspace/apps bind, the
      // individual app folder is bound directly under it.
      '-v', `${this.workspaceRoot}/apps/${appId}:/workspace/apps/${appId}`,
      '-v', `${this.workspaceRoot}/node_modules:/workspace/node_modules:ro`,
      '-v', `${this.workspaceRoot}/packages:/workspace/packages:ro`,
      '-v', `${this.workspaceRoot}/package.json:/workspace/package.json:ro`,
      '-v', `${this.workspaceRoot}/pnpm-lock.yaml:/workspace/pnpm-lock.yaml:ro`,
      '-v', `${this.workspaceRoot}/pnpm-workspace.yaml:/workspace/pnpm-workspace.yaml:ro`,
      // Per-instance state (no slicing — this is unique to each instance).
      '-v', `${instDataDir}:/data`,
      // Two-dir cap allowlist.
      '-v', `${toolBinDir}:/aura/all-tools:ro`,
      '-v', `${myTools}:/aura/my-tools`,
      // Identity + callback URL.
      '-e', `APP_ID=${appId}`,
      '-e', `APP_INSTANCE_ID=${instanceId}`,
      '-e', `APP_PORT=${port}`,
      '-e', `OS_API_BASE=${this.osApiBase}`,
      '-e', `AURA_LAYER_TAG=[ctnr]`,
      '-e', `PATH=/aura/my-tools:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      BASE_IMAGE,
    ];
    a.push(...entrypoint);
    return a;
  }

  private resolveEntrypoint(appId: string, manifest: AppManifest): string[] {
    const entrypointPath = join(this.appsDir, appId, manifest.entrypoint);
    if (existsSync(entrypointPath)) return ['bash', `/workspace/apps/${appId}/${manifest.entrypoint}`];
    return ['bash', '-c', SYNTHESISED_ENTRYPOINT];
  }

  private containerName(instanceId: string): string {
    // Docker names must be [a-zA-Z0-9_.-]; instance IDs are
    // "com.aura.terminal-3" — `.` is allowed but `:` (used in some
    // instanceId schemes) is not. Sanitise defensively.
    return 'aura-' + instanceId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  }

  /** Probe the app's health endpoint until ready or timeout. */
  private async waitHealthy(instanceId: string, appId: string, hostname: string, port: number): Promise<void> {
    const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;
    let lastBody: string | null = null;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://${hostname}:${port}/api/lifecycle/health`);
        if (res.ok) {
          // Identity check parallels ProotRunner — guard against the
          // "wrong app squatting our port" hazard. With container-per-app
          // this is extremely unlikely (one container, one app), but
          // keeping the check costs nothing and catches misconfig.
          const body = await res.text();
          lastBody = body;
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
    const url = `http://${tracked.hostname}:${tracked.port}/api/lifecycle/${hook}`;
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
    const url = `http://${tracked.hostname}:${tracked.port}/api/lifecycle/${hook}`;
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
    try { execSync(`docker stop -t 5 ${tracked.containerId}`, { stdio: 'ignore', timeout: 8_000 }); } catch { /* may already be dead */ }
    this.handleExit(instanceId, 0);
  }
  forceKill(instanceId: string): boolean {
    const tracked = this.containers.get(instanceId);
    if (!tracked) return false;
    try { execSync(`docker kill ${tracked.containerId}`, { stdio: 'ignore', timeout: 5_000 }); } catch { /* already gone */ }
    this.handleExit(instanceId, null);
    return true;
  }
  private handleExit(instanceId: string, code: number | null): void {
    const tracked = this.containers.get(instanceId);
    if (!tracked) return;
    if (tracked.logTail && !tracked.logTail.killed) { try { tracked.logTail.kill(); } catch { /* ignore */ } }
    const cb = tracked.exitCb;
    this.containers.delete(instanceId);
    if (cb) cb(code);
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
    return Array.from(this.containers.values()).map((t) => t.pid).filter((p) => p > 0);
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
}
