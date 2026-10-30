/**
 * One shared `/api/apps` read for the whole desktop.
 *
 * The Process Manager, the notification labels and the console bridge all
 * want the app list; each used to fetch it on its own (3× at boot, again on
 * every app/activity event). Callers now share one in-flight request and a
 * short-lived copy; `app:*` / `activity:*` events mark the copy stale.
 *
 * The console bridge's probe in OSLayout's <head> starts before any module
 * runs; it leaves its promise on `window.__auraAppsBoot`, and the first
 * snapshot adopts it instead of asking again.
 */
import { createLogger } from '@aura/core/logger';

const log = createLogger('shell:fetch');

export type AppsList = Array<Record<string, unknown> & {
  manifest?: { id?: string; name?: string; icon?: string; [k: string]: unknown };
  instances?: unknown[];
  activities?: unknown[];
}>;

let cached: AppsList | null = null;
let cachedAt = 0;
let stale = true;
let inflight: Promise<AppsList> | null = null;
let subscribed = false;
const counts = { network: 0, shared: 0, cached: 0, adoptedBoot: 0 };

function subscribeStale(): void {
  if (subscribed || typeof window === 'undefined') return;
  subscribed = true;
  void import('./osEvents.ts')
    .then(({ osEvents }) => { osEvents?.subscribe(['app:*', 'activity:*'], () => { stale = true; }); })
    .catch(() => { subscribed = false; });
}

function fetchApps(): Promise<AppsList> {
  const boot = typeof window !== 'undefined'
    ? (window as unknown as { __auraAppsBoot?: Promise<AppsList | null> }).__auraAppsBoot
    : undefined;
  if (boot) {
    (window as unknown as { __auraAppsBoot?: unknown }).__auraAppsBoot = undefined;
    counts.adoptedBoot++;
    log.debug('/api/apps: adopted the head probe');
    return boot.then((list) => (Array.isArray(list) ? list : fetchNetwork()));
  }
  return fetchNetwork();
}

async function fetchNetwork(): Promise<AppsList> {
  counts.network++;
  log.debug('/api/apps: network', `#${counts.network}`);
  const res = await fetch('/api/apps');
  if (!res.ok) throw new Error(`/api/apps → HTTP ${res.status}`);
  return await res.json() as AppsList;
}

/**
 * The app list. Fresh enough copies (younger than `maxAgeMs` and not marked
 * stale by an event) are shared; concurrent callers share one request.
 * `fresh: true` skips the copy (still joins a request already in flight).
 */
export function getAppsSnapshot(opts: { maxAgeMs?: number; fresh?: boolean } = {}): Promise<AppsList> {
  subscribeStale();
  const maxAge = opts.maxAgeMs ?? 2000;
  if (!opts.fresh && cached && !stale && Date.now() - cachedAt < maxAge) {
    counts.cached++;
    log.debug('/api/apps: cached copy');
    return Promise.resolve(cached);
  }
  if (inflight) {
    counts.shared++;
    log.debug('/api/apps: joined the request in flight');
    return inflight;
  }
  stale = false;
  inflight = fetchApps()
    .then((list) => { cached = list; cachedAt = Date.now(); return list; })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Counters for the boot report / debugging. */
export function appsSnapshotStats(): Readonly<typeof counts> {
  return { ...counts };
}

/** Test hook. */
export function _resetAppsSnapshot(): void {
  cached = null; cachedAt = 0; stale = true; inflight = null;
  counts.network = counts.shared = counts.cached = counts.adoptedBoot = 0;
}
