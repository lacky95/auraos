import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppManifest } from '../types/manifest.js';

const HEALTH_CHECK_INTERVAL_MS = 200;
const HEALTH_CHECK_TIMEOUT_MS = 30_000;
const LIFECYCLE_TIMEOUT_MS = 5_000;

interface SpawnedApp {
  process: ChildProcess;
  port: number;
  appId: string;
}

export class ProotRunner {
  private processes = new Map<string, SpawnedApp>();
  private baseRootfs: string;
  private toolchainDir: string;
  private appsDir: string;
  private dataDir: string;
  private osApiBase: string;

  constructor(opts: {
    baseRootfs: string;
    toolchainDir: string;
    appsDir: string;
    dataDir: string;
    osApiBase: string;
  }) {
    this.baseRootfs = opts.baseRootfs;
    this.toolchainDir = opts.toolchainDir;
    this.appsDir = opts.appsDir;
    this.dataDir = opts.dataDir;
    this.osApiBase = opts.osApiBase;
  }

  async spawn(instanceId: string, appId: string, port: number, manifest: AppManifest): Promise<number> {
    const appDir = join(this.appsDir, appId);
    const dataDir = join(this.dataDir, 'apps', appId, instanceId);

    const useProotEnv = process.env['AURA_USE_PROOT'];
    const prooted = useProotEnv === 'true' && existsSync(this.baseRootfs);
    const args = this.buildProotArgs(port, manifest, appDir, dataDir, prooted);

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      APP_ID: appId,
      APP_INSTANCE_ID: instanceId,
      APP_PORT: String(port),
      OS_API_BASE: this.osApiBase,
    };

    console.log(`[ProotRunner] Spawning ${instanceId} (app=${appId}) on port ${port}`);

    const child = spawn(prooted ? 'proot' : 'bash', prooted ? args : [join(appDir, manifest.entrypoint)], {
      cwd: appDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (d) => process.stdout.write(`[${instanceId}] ${d}`));
    child.stderr?.on('data', (d) => process.stderr.write(`[${instanceId}] ${d}`));

    this.processes.set(instanceId, { process: child, port, appId });

    await this.waitHealthy(instanceId, port);
    return child.pid ?? 0;
  }

  private buildProotArgs(
    port: number,
    manifest: AppManifest,
    appDir: string,
    dataDir: string,
    useProot: boolean,
  ): string[] {
    if (!useProot) return [join(appDir, manifest.entrypoint)];

    const args = [
      `--rootfs=${this.baseRootfs}`,
      `--bind=${appDir}:/app`,
      `--bind=${dataDir}:/data`,
      '--bind=/proc',
      '--bind=/dev',
      '--bind=/tmp',
      '--cwd=/app',
    ];

    const toolBinDir = join(this.toolchainDir, 'bin');
    for (const tool of manifest.tools) {
      const toolPath = join(toolBinDir, tool === 'claude-code' ? 'claude' : tool);
      if (existsSync(toolPath)) {
        args.push(`--bind=${toolPath}:/usr/local/bin/${tool === 'claude-code' ? 'claude' : tool}`);
      }
    }

    args.push('bash', `/app/${manifest.entrypoint}`);
    return args;
  }

  private async waitHealthy(instanceId: string, port: number): Promise<void> {
    const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://localhost:${port}/api/lifecycle/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return;
      } catch {
        // not ready yet
      }
      await sleep(HEALTH_CHECK_INTERVAL_MS);
    }
    throw new Error(`[ProotRunner] ${instanceId} did not become healthy within ${HEALTH_CHECK_TIMEOUT_MS}ms`);
  }

  async callLifecycle(instanceId: string, hook: string): Promise<void> {
    const spawned = this.processes.get(instanceId);
    if (!spawned) throw new Error(`[ProotRunner] ${instanceId} is not running`);
    const url = `http://localhost:${spawned.port}/api/lifecycle/${hook}`;
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
      const res = await fetch(`http://localhost:${spawned.port}/api/lifecycle/${hook}`, {
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
    spawned.process.kill('SIGTERM');
    await sleep(5000).catch(() => undefined);
    if (!spawned.process.killed) spawned.process.kill('SIGKILL');
  }

  /** Immediate SIGKILL without grace period — for force-kill from process manager. */
  forceKill(instanceId: string): boolean {
    const spawned = this.processes.get(instanceId);
    if (!spawned) return false;
    this.processes.delete(instanceId);
    spawned.process.removeAllListeners('exit');
    spawned.process.kill('SIGKILL');
    return true;
  }

  getPort(instanceId: string): number | null {
    return this.processes.get(instanceId)?.port ?? null;
  }

  isRunning(instanceId: string): boolean {
    return this.processes.has(instanceId);
  }

  onExit(instanceId: string, cb: (code: number | null) => void): void {
    this.processes.get(instanceId)?.process.on('exit', cb);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
