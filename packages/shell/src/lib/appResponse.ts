import { getAppManager } from '@aura/core';
import type { AppManifest, AppInstance } from '@aura/core';

export interface AppHealth {
  /** Process is alive (kill -0 PID succeeds). null = no PID known. */
  processAlive: boolean | null;
  /** HTTP health probe to app's /api/lifecycle/health returned 2xx. null = no port. */
  httpHealthy: boolean | null;
  /** Round-trip time of HTTP probe in ms. null if probe didn't run. */
  httpLatencyMs: number | null;
  /** Last error from probe (if any). */
  error: string | null;
}

export interface InstanceDTO {
  instance: AppInstance;
  health: AppHealth;
}

/** DTO for a single app: manifest + all its running instances. */
export interface AppDTO {
  manifest: AppManifest;
  instances: InstanceDTO[];
}

const HEALTH_TIMEOUT_MS = 1000;

async function probeHealth(instance: AppInstance): Promise<AppHealth> {
  const health: AppHealth = {
    processAlive: null,
    httpHealthy: null,
    httpLatencyMs: null,
    error: null,
  };

  if (instance.pid !== null) {
    try {
      process.kill(instance.pid, 0);
      health.processAlive = true;
    } catch {
      health.processAlive = false;
    }
  }

  if (instance.port !== null) {
    const start = Date.now();
    try {
      const res = await fetch(`http://localhost:${instance.port}/api/lifecycle/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      health.httpLatencyMs = Date.now() - start;
      health.httpHealthy = res.ok;
      if (!res.ok) health.error = `HTTP ${res.status}`;
    } catch (err) {
      health.httpLatencyMs = Date.now() - start;
      health.httpHealthy = false;
      health.error = err instanceof Error ? err.message : String(err);
    }
  }

  return health;
}

export async function buildInstanceDTO(instanceId: string): Promise<InstanceDTO | null> {
  const mgr = getAppManager();
  const instance = mgr.getInstance(instanceId);
  if (!instance) return null;
  const health = await probeHealth(instance);
  return { instance, health };
}

export async function buildAppDTO(appId: string): Promise<AppDTO | null> {
  const mgr = getAppManager();
  const manifest = mgr.getManifest(appId);
  if (!manifest) return null;
  const instances = await Promise.all(
    mgr.getInstancesByApp(appId).map((inst) => probeHealth(inst).then((health) => ({ instance: inst, health }))),
  );
  return { manifest, instances };
}

export function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function errorResponse(message: string, status = 500) {
  return jsonResponse({ error: message }, status);
}
