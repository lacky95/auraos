/**
 * Server side of the per-app frame route: which apps the desktop opens on
 * their App Host. A failed or missing lookup means `proxy`, today's behavior.
 *
 * PHASE2-CUTOVER: remove with `frameRoute`, when every app is on its App Host.
 */
import * as core from '@aura/core';

type FrameRouteValue = 'proxy' | 'host';
type GetFrameRoute = (appId: string) => Promise<FrameRouteValue> | FrameRouteValue;

/** Namespace access: the registry stream provides these at integration. */
function frameRouteReader(kv: unknown): GetFrameRoute | null {
  const c = core as unknown as {
    createAppHostRegistry?: (kv: unknown) => { getFrameRoute?: GetFrameRoute };
    getFrameRoute?: GetFrameRoute;
  };
  const registry = c.createAppHostRegistry?.(kv);
  if (registry?.getFrameRoute) return registry.getFrameRoute.bind(registry);
  return c.getFrameRoute ?? null;
}

export async function hostRouteAppIds(appIds: string[], kv: unknown): Promise<string[]> {
  try {
    const get = frameRouteReader(kv);
    if (!get) return [];
    const routes = await Promise.all(appIds.map(async (id) => {
      try { return (await get(id)) === 'host' ? id : null; }
      catch { return null; }
    }));
    return routes.filter((id): id is string => id !== null);
  } catch {
    return [];
  }
}

/**
 * `frame-ancestors` for the shell's own documents, or null to leave a response
 * alone. App Hosts are other origins, so `'self'` already stops them framing
 * the desktop. Login and setup send their stricter `'none'` themselves.
 *
 * PHASE2-CUTOVER: tighten to 'none' once no app document is served on the shell origin.
 */
export const SHELL_FRAME_ANCESTORS = "frame-ancestors 'self'";

export function shellFramePolicy(pathname: string, contentType: string | null, existingCsp: string | null): string | null {
  if (existingCsp) return null;
  if (pathname === '/api' || pathname.startsWith('/api/')) return null;
  if (!contentType || !/^text\/html\b/i.test(contentType)) return null;
  return SHELL_FRAME_ANCESTORS;
}
