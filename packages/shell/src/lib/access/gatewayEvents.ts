import type { AppManager, Principal } from '@aura/core';
import { gatewayInstance } from './identify.ts';
import { kvEventAllowed } from './kvAccess.ts';

/**
 * What an app instance sees of `/api/apps/events`. The route stays one
 * stream; an App Host caller (a verified gateway claim) and an instance that
 * presents its own token both get this view, so only the shell's own
 * subscribers see the whole bus.
 *
 * An allowlist, so a new bus event stays private until it is added here:
 * the theme, the caller's own app and activities, and `kv:changed` for its
 * own bucket and the `os` keys kvAccess.ts lists.
 */

const SHARED_EVENTS: ReadonlySet<string> = new Set(['theme:changed', 'mode:changed']);

const OWN_APP_EVENTS: ReadonlySet<string> = new Set([
  'app:stateChanged', 'app:crashed', 'app:sidecarsChanged',
  'app:restarting', 'app:restarted', 'app:restartFailed',
  'activity:opened', 'activity:closed', 'activity:focus', 'activity:navigated',
  'activity:breadcrumbChanged', 'activity:flightChanged', 'activity:flightClosing',
  'activity:flightKept', 'activity:flightAction',
]);

export interface GatewayEventView {
  /** Whether the calling instance still exists. The stream ends when it doesn't. */
  live(): boolean;
  allows(type: string, ev: unknown): boolean;
}

/** The view of one app instance. */
export function instanceEventView(
  caller: { appId: string; instanceId: string },
  mgr: Pick<AppManager, 'getInstance'>,
): GatewayEventView {
  const { appId, instanceId } = caller;
  const live = () => mgr.getInstance(instanceId)?.appId === appId;
  return {
    live,
    allows(type, ev) {
      if (!live()) return false;
      if (SHARED_EVENTS.has(type)) return true;
      const e = (ev ?? {}) as { appId?: unknown; namespace?: unknown; key?: unknown };
      if (type === 'kv:changed') return typeof e.namespace === 'string' && kvEventAllowed(e.namespace, e.key, appId);
      return OWN_APP_EVENTS.has(type) && e.appId === appId;
    },
  };
}

/** Null without a gateway claim, `invalid` with one that doesn't verify. */
export function gatewayEventView(
  request: Request,
  mgr: Pick<AppManager, 'getInstance'>,
): GatewayEventView | 'invalid' | null {
  const inst = gatewayInstance(request, mgr);
  if (inst === null || inst === 'invalid') return inst;
  return instanceEventView(inst, mgr);
}

/**
 * The view of a caller outside the gateway: an instance that presented its
 * own token gets its instance view; a sidecar too. Null (the whole stream)
 * for everyone else, and for the System Terminal's own instance, the owner's
 * terminal (D29), where `aura events` and `aura ps -w` run.
 */
export async function principalEventView(
  principal: Principal,
  mgr: Pick<AppManager, 'getInstance'>,
  isSystemTerminal: (appId: string) => Promise<boolean>,
): Promise<GatewayEventView | null> {
  if (principal.kind !== 'instance') return null;
  if (!principal.sidecar && await isSystemTerminal(principal.appId)) return null;
  return instanceEventView(principal, mgr);
}
