import { errorResponse } from './appResponse.js';

/** The `identity` field of an install/update body (install + update routes). */
export function parseIdentity(raw: unknown): { action: 'update-existing' | 'install-as' | 'install-copy'; appId?: string } | null | Response {
  if (raw === undefined || raw === null) return null;
  const r = raw as { action?: unknown; appId?: unknown };
  const actions = ['update-existing', 'install-as', 'install-copy'];
  if (typeof r.action !== 'string' || !actions.includes(r.action)) {
    return errorResponse(`identity.action must be one of ${actions.join(', ')}`, 400);
  }
  if (r.appId !== undefined && (typeof r.appId !== 'string' || !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(r.appId))) {
    return errorResponse('identity.appId must be a reverse-domain app id', 400);
  }
  return { action: r.action as 'update-existing' | 'install-as' | 'install-copy', ...(typeof r.appId === 'string' ? { appId: r.appId } : {}) };
}
