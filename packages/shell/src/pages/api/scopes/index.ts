import type { APIRoute } from 'astro';
import { getAppManager, ScopeRegistry } from '@aura/core';
import { defaultKv } from '@aura/kv-store';
import { jsonResponse } from '../../../lib/appResponse.js';

const KV_KEYS: Record<string, string> = {
  global: 'scopes/global',
  user:   'scopes/users/default',
};

async function getScopeGitRepo(id: string): Promise<string | null> {
  const key = KV_KEYS[id];
  if (!key) return null;
  const kv = defaultKv();
  try {
    const val = await kv.getValue<{ gitRepo?: string }>('os', key);
    return val?.gitRepo ?? null;
  } catch {
    return null;
  } finally {
    await kv.close().catch(() => undefined);
  }
}

/**
 * GET /api/scopes
 * Returns all three scope definitions with appCount + gitRepo.
 *
 * Constructs ScopeRegistry directly from env vars to avoid depending on
 * the AppManager globalThis singleton having getScopeRegistry() — that
 * method may be absent if the singleton was cached before the scope system
 * was deployed and the shell hasn't fully restarted yet.
 */
export const GET: APIRoute = async () => {
  const registry = new ScopeRegistry({
    systemAppsDir: process.env['AURA_APPS_DIR'] ?? '/workspace/apps',
    dataDir:       process.env['AURA_DATA_DIR'] ?? '/data',
  });
  const scopes = registry.getAll();

  // Count manifests per scope. Fall back to empty if getManifests isn't
  // present on an old cached singleton.
  const countByScopeId: Record<string, number> = {};
  try {
    const mgr = getAppManager();
    for (const m of mgr.getManifests()) {
      const sid = (m as { scopeId?: string }).scopeId ?? 'system';
      countByScopeId[sid] = (countByScopeId[sid] ?? 0) + 1;
    }
  } catch { /* stale singleton — counts stay 0 */ }

  const result = await Promise.all(scopes.map(async (scope) => ({
    ...scope,
    appCount: countByScopeId[scope.id] ?? 0,
    gitRepo:  scope.immutable ? null : await getScopeGitRepo(scope.id),
  })));

  return jsonResponse(result);
};
