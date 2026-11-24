import type * as core from '@aura/core';
import { gatewayInstance } from './access/identify.ts';

/**
 * The app making a call, when that is proved: an App Host gateway claim, or
 * the instance token the OS injects into every app container
 * (`Authorization: Bearer $AURA_INSTANCE_TOKEN`, the SDK's server side).
 * `invalid` = a claim that doesn't verify. Null = no app identity (the owner's
 * desktop, the CLI, an unverified machine call), which these Terminal rules
 * leave to Phase 3 (see server/terminal-embed.mjs).
 */
export function verifiedAppCaller(
  request: Request,
  mgr: Pick<ReturnType<typeof core.getAppManager>, 'getInstance' | 'tokens'>,
): { appId: string; instanceId: string } | 'invalid' | null {
  const gw = gatewayInstance(request, mgr);
  if (gw === 'invalid') return 'invalid';
  if (gw) return { appId: gw.appId, instanceId: gw.instanceId };
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token) return null;
  const claims = mgr.tokens.verify(token);
  if (!claims) return null;
  const inst = mgr.getInstance(claims.instanceId);
  return inst ? { appId: inst.appId, instanceId: inst.instanceId } : 'invalid';
}
