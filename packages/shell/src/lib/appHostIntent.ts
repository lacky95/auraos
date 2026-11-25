import { loadAppHostServices } from '../../server/app-host-auth.mjs';
import { classifyHost, hostListed } from '../../server/host-policy.mjs';

export const VIEW_ACTION = 'aura.intent.action.VIEW';

interface LabelRegistry {
  resolveLabel(label: string): Promise<{ status: string; record?: { appId: string } }>;
}

/**
 * The app a VIEW intent for an App Host address means, or null. Aura Browser
 * never frames another app: it sends the address as a VIEW, and the OS opens
 * the app that holds that App Host (its own Activity) instead of resolving
 * the http(s) filter back to a browser. Only a label the registry holds as
 * active counts; anything else stays an ordinary web address.
 */
export async function appHostViewTarget(
  intent: { action: string; appId?: string; instanceId?: string; uri?: string },
  deps: { registry?: () => Promise<LabelRegistry | null> } = {},
): Promise<string | null> {
  if (intent.action !== VIEW_ACTION || intent.appId || intent.instanceId || !intent.uri) return null;
  let u: URL;
  try { u = new URL(intent.uri); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
  const host = classifyHost(u.host);
  if (host.kind !== 'app' || !hostListed(host)) return null;
  const registry = await (deps.registry ?? (async () => (await loadAppHostServices())?.registry ?? null))();
  if (!registry) return null;
  const found = await registry.resolveLabel(host.label).catch(() => null);
  return found?.status === 'active' && found.record?.appId ? found.record.appId : null;
}
