import type * as core from '@aura/core';
import { buildAppHost } from '@aura/core/host-rules';
import { appHostAuth } from '../../server/app-host-auth.mjs';
import { originOf } from '../../server/host-policy.mjs';

/**
 * A one-time code that signs a browser in to one running instance's App Host:
 * the Shell's own handoff (`/api/app-hosts/handoff`) and a Terminal session an
 * app may show (`/api/terminal/embed`, D25). The label and slot come from the
 * registry, never from the caller.
 */

type AppManager = ReturnType<typeof core.getAppManager>;
interface HandoffServices {
  registry: core.AppHostRegistry;
  frameRoute: (appId: string) => Promise<'proxy' | 'host'>;
}

export interface HandoffIdentity {
  sid: string;
  userId: string | null;
  sessionExpiresAt: number | null;
}

export type HandoffResult =
  | { code: string; origin: string; slot: number }
  | { error: string; status: number };

export async function issueAppHostHandoff(opts: {
  services: HandoffServices;
  mgr: AppManager;
  appId: string;
  instanceId: string;
  returnPath: string;
  scheme: string;
  desktopHost: string;
  identity: HandoffIdentity;
}): Promise<HandoffResult> {
  const { services, mgr, appId, instanceId, identity } = opts;
  if (await services.frameRoute(appId) !== 'host') return { error: 'not-host-routed', status: 409 };
  const instance = mgr.getInstance(instanceId);
  if (!instance || instance.appId !== appId || instance.inPool) return { error: 'not-found', status: 404 };

  const heldSlots = async () => (await services.registry.listForApp(appId))
    .filter((r) => r.state === 'active')
    .flatMap((r) => r.slots.filter((s) => s.instanceId === instanceId));
  let held = await heldSlots();
  // PHASE2-CUTOVER: only an instance started before its app moved to `host` lacks a slot.
  if (held.length === 0) {
    await mgr.claimHostSlot(appId, instanceId);
    held = await heldSlots();
  }
  if (held.length !== 1) return { error: 'slot-not-assigned', status: 409 };
  const label = held[0]!.label;
  const resolved = await services.registry.resolveLabel(label);
  if (resolved.status === 'retired') return { error: 'retired', status: 410 };
  if (resolved.status !== 'active' || resolved.record.appId !== appId || resolved.slot.instanceId !== instanceId) {
    return { error: 'slot-not-assigned', status: 409 };
  }
  const { record, slot } = resolved;
  const host = buildAppHost(label, opts.desktopHost);
  if (!host) return { error: 'no-app-hosts', status: 409 };

  const scopeUser = record.instanceScope.kind === 'user' ? record.instanceScope.userId : 'default';
  const origin = originOf(opts.scheme, host);
  const { code } = appHostAuth().issueCode({
    aud: origin, label, installationId: record.installationId, appId, slot: slot.slot,
    userId: identity.userId ?? scopeUser, sid: identity.sid, returnPath: opts.returnPath,
    sessionExpiresAt: identity.sessionExpiresAt,
  });
  return { code, origin, slot: slot.slot };
}
