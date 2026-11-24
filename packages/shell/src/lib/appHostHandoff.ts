import type * as core from '@aura/core';
import { buildAppHost } from '@aura/core/host-rules';
import type { APIContext } from 'astro';
import { appHostAuth, type AppHostServices } from '../../server/app-host-auth.mjs';
import { isSystemInstallation } from '../../server/gateway-identity.mjs';
import { edgeView, originOf } from '../../server/host-policy.mjs';
import { currentOwnerSession } from './authSurface.js';

/**
 * A one-time code that signs a browser in to one running instance's App Host:
 * the Shell's own handoff (`/api/app-hosts/handoff`) and a Terminal session an
 * app may show (`/api/terminal/embed`, D25). The label and slot come from the
 * registry, never from the caller.
 */

type AppManager = ReturnType<typeof core.getAppManager>;
interface HandoffServices {
  registry: core.AppHostRegistry & Partial<Pick<AppHostServices['registry'], 'getInstallation'>>;
}

export interface HandoffIdentity {
  sid: string;
  userId: string;
  sessionExpiresAt: number | null;
}

/**
 * The owner behind a request from the Shell's own page, or why not. Exact
 * Origin: App Hosts are same-site with the Shell, so this is what stops an
 * app's page from acting as the desktop.
 */
export async function shellOwner(ctx: Pick<APIContext, 'request' | 'cookies'> & { clientAddress?: string }): Promise<
  | { edge: ReturnType<typeof edgeView>; identity: HandoffIdentity }
  | { edge: ReturnType<typeof edgeView>; error: string; status: number }
> {
  const { request } = ctx;
  let peer: string | undefined;
  try { peer = ctx.clientAddress; } catch { peer = undefined; }
  const edge = edgeView({ peer, header: (name: string) => request.headers.get(name) });
  const site = request.headers.get('sec-fetch-site');
  if ((site !== null && site !== 'same-origin') || request.headers.get('origin') !== edge.origin) {
    return { edge, error: 'forbidden-origin', status: 403 };
  }
  let current: Awaited<ReturnType<typeof currentOwnerSession>>;
  try { current = await currentOwnerSession(ctx as never); } catch { return { edge, error: 'unavailable', status: 503 }; }
  if (!current) return { edge, error: 'login-required', status: 401 };
  return { edge, identity: { sid: current.sessionId, userId: current.userId, sessionExpiresAt: current.expiresAt } };
}

/** `system`: the frame shows the app's `system` installation, so the desktop may trust its messages (D45). */
export type HandoffResult =
  | { code: string; origin: string; slot: number; system: boolean }
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
  /** A restricted sign-in for one embedded Terminal session (D25, 5.16). */
  embed?: core.AppHostEmbedClaim;
}): Promise<HandoffResult> {
  const { services, mgr, appId, instanceId, identity } = opts;
  const instance = mgr.getInstance(instanceId);
  if (!instance || instance.appId !== appId || instance.inPool) return { error: 'not-found', status: 404 };

  const heldSlots = async () => (await services.registry.listForApp(appId))
    .filter((r) => r.state === 'active')
    .flatMap((r) => r.slots.filter((s) => s.instanceId === instanceId));
  let held = await heldSlots();
  // An instance without a slot yet (adopted from before slots, or its slot was freed) claims it here.
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

  const origin = originOf(opts.scheme, host);
  const { code } = appHostAuth().issueCode({
    aud: origin, label, installationId: record.installationId, appId, slot: slot.slot,
    userId: identity.userId, sid: identity.sid, returnPath: opts.returnPath,
    sessionExpiresAt: identity.sessionExpiresAt, embed: opts.embed ?? null,
  });
  return { code, origin, slot: slot.slot, system: await isSystemInstallation(services.registry, record) };
}
