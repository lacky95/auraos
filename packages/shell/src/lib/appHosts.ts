import { appHostUrl, getAppManager, isRawIpHost, type AppManifest } from '@aura/core';

/**
 * App hosts as the API hands them out (`/api/hosts`, `/api/apps/<id>/hosts`).
 * The URL is built from the host the CALLER used — `{name}--{that host}`, same
 * scheme and port — so nothing is stored or configured. Behind an edge the
 * shell reads `X-Forwarded-Proto`/`-Host`. Routing: server/app-hosts.mjs.
 */
export interface AppHostDTO {
  /** `<appId>/<name>`, like an interface ref. */
  id: string;
  appId: string;
  name: string;
  /** `app` (its own server) or `service:<template>` (a sidecar). */
  target: string;
  port: number | null;
  description?: string;
  /** `live` while an instance runs; `catalog` = installed, starts on first request. */
  status: 'live' | 'catalog';
  /** Absolute URL for this caller, or null when it reached the shell by raw IP / single-label host. */
  url: string | null;
  /** Why `url` is null. */
  reason?: 'raw-ip';
}

/** The desktop's scheme + host as the caller sees it. */
export function callerDesktop(request: Request): { scheme: string; host: string } {
  const u = new URL(request.url);
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || request.headers.get('host') || u.host;
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || u.protocol.replace(':', '');
  return { scheme: proto === 'https' ? 'https' : 'http', host };
}

export function listAppHosts(request: Request, appId?: string): AppHostDTO[] {
  const mgr = getAppManager();
  const desktop = callerDesktop(request);
  const raw = isRawIpHost(desktop.host);
  const out: AppHostDTO[] = [];
  for (const m of mgr.getManifests() as AppManifest[]) {
    if (appId && m.id !== appId) continue;
    if (!m.hosts?.length) continue;
    const live = mgr.getInstancesByApp(m.id).some((i) =>
      i.port != null && i.state !== 'error' && i.state !== 'destroying' && i.state !== 'destroyed');
    for (const h of m.hosts) {
      const tpl = h.service ? m.services.find((s) => s.name === h.service) : undefined;
      const url = appHostUrl(h.name, desktop);
      out.push({
        id: `${m.id}/${h.name}`,
        appId: m.id,
        name: h.name,
        target: h.service ? `service:${h.service}` : 'app',
        port: h.port ?? tpl?.port ?? null,
        ...(h.description ? { description: h.description } : {}),
        status: live ? 'live' : 'catalog',
        url,
        ...(url === null && raw ? { reason: 'raw-ip' as const } : {}),
      });
    }
  }
  return out;
}
