import { ownerUiApp } from '../../server/gateway-identity.mjs';
import { OPEN_TERMINAL_ACTION, TERMINAL_APP_ID } from '../../server/terminal-embed.mjs';

/**
 * Why a verified app may not name this intent's target, or null. The target
 * is `appId`, else the app of `instanceId`. A system app (its active copy is
 * the `system` one) or a trusted system UI (D45, any copy) is never an app's
 * to start or reach by name.
 */
export function explicitTargetRefusal(
  intent: { action: string; appId?: string; instanceId?: string },
  caller: { appId: string },
  mgr: { getInstance(id: string): { appId: string } | undefined; getManifest(appId: string): unknown },
): string | null {
  const target = intent.appId ?? (intent.instanceId ? mgr.getInstance(intent.instanceId)?.appId : undefined);
  if (!target || target === caller.appId) return null;
  if (intent.action === OPEN_TERMINAL_ACTION && target === TERMINAL_APP_ID) return null;
  const scope = (mgr.getManifest(target) as { scopeId?: string } | undefined)?.scopeId;
  if (scope !== 'system' && !ownerUiApp(target)) return null;
  return `an app may not name ${target} as an intent target (a system app); send the intent without appId to let the OS resolve it`;
}
