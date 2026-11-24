import type { AppManager } from '@aura/core';
import { gatewayInstance } from './identify.ts';
import { kvReadAllowed } from './kvAccess.ts';

/**
 * What an App Host caller sees of `/api/apps/events`. The route stays one
 * stream; only a request with a verified gateway claim gets this view, so the
 * shell's own subscribers are unaffected.
 *
 * An allowlist, so a new bus event stays private until it is added here:
 * the theme, the caller's own app and activities, and `kv:changed` for a
 * namespace the KV route would let it read.
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

/** Null without a gateway claim, `invalid` with one that doesn't verify. */
export function gatewayEventView(
  request: Request,
  mgr: Pick<AppManager, 'getInstance'>,
): GatewayEventView | 'invalid' | null {
  const inst = gatewayInstance(request, mgr);
  if (inst === null || inst === 'invalid') return inst;
  const { appId, instanceId } = inst;
  const live = () => mgr.getInstance(instanceId)?.appId === appId;
  return {
    live,
    allows(type, ev) {
      if (!live()) return false;
      if (SHARED_EVENTS.has(type)) return true;
      const e = (ev ?? {}) as { appId?: unknown; namespace?: unknown };
      if (type === 'kv:changed') return typeof e.namespace === 'string' && kvReadAllowed(e.namespace, appId);
      return OWN_APP_EVENTS.has(type) && e.appId === appId;
    },
  };
}
