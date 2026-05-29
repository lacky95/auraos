import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
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
 */
export const GET: APIRoute = async () => {
  const mgr      = getAppManager();
  const registry = mgr.getScopeRegistry();
  const scopes   = registry.getAll();

  const countByScopeId: Record<string, number> = {};
  for (const m of mgr.getManifests()) {
    const sid = (m as { scopeId?: string }).scopeId ?? 'system';
    countByScopeId[sid] = (countByScopeId[sid] ?? 0) + 1;
  }

  const result = await Promise.all(scopes.map(async (scope) => ({
    ...scope,
    appCount: countByScopeId[scope.id] ?? 0,
    gitRepo:  scope.immutable ? null : await getScopeGitRepo(scope.id),
  })));

  return jsonResponse(result);
};
