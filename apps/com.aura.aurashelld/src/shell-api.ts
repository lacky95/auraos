/**
 * The shell's HTTP API, typed, as seen from inside this service's container.
 *
 * Everything the daemon does to the OS goes through here: reads of
 * /api/apps and the workspace KV, the lifecycle routes, and `ui()` — the
 * command channel into the browser (packages/shell/src/lib/uiCommandBroker.ts).
 * `setFetch` lets the tests script every route without a network.
 */
export const OS_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';

let fetchImpl: typeof fetch = (input, init) => fetch(input, init);
/** Test hook: replace the transport. */
export function setFetch(f: typeof fetch): void { fetchImpl = f; }

export class ShellApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ShellApiError';
    this.status = status;
  }
}

async function call<T>(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${OS_BASE}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ShellApiError(0, `the OS API at ${OS_BASE} is not reachable: ${(err as Error).message}`);
  }
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try { body = text ? JSON.parse(text) as Record<string, unknown> : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = (body?.['message'] ?? body?.['error']) as string | undefined;
    throw new ShellApiError(res.status, msg ?? `HTTP ${res.status} on ${path}`);
  }
  return (body ?? {}) as T;
}

const jsonInit = (method: string, body: unknown): RequestInit =>
  ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ── Wire shapes (the subset this daemon reads) ──────────────────────────────

export interface ManifestLite {
  id: string;
  name: string;
  description?: string;
  componentType?: 'activity' | 'service';
  backgroundService?: boolean;
  category?: string;
}
export interface InstanceLite { instanceId: string; appId: string; state: string; pid: number | null; port: number | null; inPool?: boolean; sidecarCount?: number }
export interface ActivityLite { activityId: string; parentInstanceId: string; appId: string; path: string; title?: string }
export interface AppRecord { manifest: ManifestLite; enabled: boolean; instances: InstanceLite[]; activities: ActivityLite[] }

export interface Workspace { id: string; name: string; layoutId: string; members: string[]; layoutState?: Record<string, unknown> }
export interface WorkspaceState { workspaces: Workspace[]; activeWorkspaceId: string }
export interface LayoutMeta { id: string; name: string; description?: string; icon?: string }

/** What the shell seeds when the KV key has never been written. */
export const DEFAULT_WORKSPACES: WorkspaceState = {
  workspaces: [{ id: 'ws-1', name: 'Main', layoutId: 'tiling', members: [] }],
  activeWorkspaceId: 'ws-1',
};

// ── Reads ───────────────────────────────────────────────────────────────────

export const listApps = () => call<AppRecord[]>('/api/apps');

export async function getWorkspaces(): Promise<WorkspaceState> {
  try {
    const r = await call<{ value?: WorkspaceState | null }>('/api/kv/os/workspaces');
    return r.value && Array.isArray(r.value.workspaces) && r.value.workspaces.length ? r.value : DEFAULT_WORKSPACES;
  } catch (err) {
    if (err instanceof ShellApiError && err.status === 404) return DEFAULT_WORKSPACES;
    throw err;
  }
}

export const listLayouts = () => call<LayoutMeta[]>('/api/os/layouts');

export async function getMru(): Promise<Record<string, number>> {
  try { return (await call<{ mru?: Record<string, number> }>('/api/admin/apps/mru')).mru ?? {}; }
  catch { return {}; }
}

/** Settings → General: time zone (IANA, '' = device), locale, clock format. Missing keys are simply unset. */
export async function getRegion(): Promise<{ timeZone: string; locale: string; clockFormat: '12h' | '24h' }> {
  const read = async (key: string) => {
    try { return (await call<{ value?: unknown }>(`/api/kv/os/${key}`)).value; } catch { return undefined; }
  };
  const [tz, loc, cf] = await Promise.all([read('timeZone'), read('locale'), read('clockFormat')]);
  return {
    timeZone: typeof tz === 'string' ? tz : '',
    locale: typeof loc === 'string' && loc ? loc : 'en-US',
    clockFormat: cf === '12h' ? '12h' : '24h',
  };
}

export async function getLockscreen(): Promise<{ lockAt?: number; unlockAt?: number } | null> {
  try { return (await call<{ value?: { lockAt?: number; unlockAt?: number } | null }>('/api/kv/os/lockscreen')).value ?? null; }
  catch { return null; }
}

export type ColorMode = 'light' | 'dark' | 'auto';
/** KV `os/theme` — the OS-wide theme picks and light/dark mode (packages/core ThemeManager). */
export interface ThemeKv { themeIdDark?: string; themeIdLight?: string; colorMode?: ColorMode; [k: string]: unknown }

export async function getTheme(): Promise<ThemeKv> {
  try { return (await call<{ value?: ThemeKv | null }>('/api/kv/os/theme')).value ?? {}; }
  catch (err) {
    if (err instanceof ShellApiError && err.status === 404) return {};
    throw err;
  }
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** Whole-blob write; the route emits workspaces:changed for every browser.
 *  Only used when no browser is connected — otherwise the page is the writer. */
export const putWorkspaces = (s: WorkspaceState) => call<unknown>('/api/kv/os/workspaces', jsonInit('PUT', { value: s }));
/** Set the light/dark mode. PUT replaces the whole value, so read-modify-write
 *  keeps the theme picks; the route emits kv:changed and every open shell re-themes. */
export async function setColorMode(mode: ColorMode): Promise<{ from: ColorMode; to: ColorMode }> {
  const previous = await getTheme();
  await call<unknown>('/api/kv/os/theme', jsonInit('PUT', { value: { ...previous, colorMode: mode } }));
  return { from: previous.colorMode ?? 'dark', to: mode };
}
export const lock   = () => call<unknown>('/api/os/lock',   { method: 'POST' });
export const unlock = () => call<unknown>('/api/os/unlock', { method: 'POST' });
export const startApp = (appId: string) =>
  call<{ instanceId: string }>(`/api/apps/${encodeURIComponent(appId)}/start`, { method: 'POST' }, 30_000);
export const stopInstance = (instanceId: string, mode: 'stop' | 'kill') =>
  call<unknown>(`/api/instances/${encodeURIComponent(instanceId)}/${mode}`, { method: 'POST' }, 30_000);
/** Activity ids contain `#`; the route decodes its segment. */
export const closeActivity = (activityId: string) =>
  call<unknown>(`/api/activities/${encodeURIComponent(activityId)}/close`, { method: 'POST' });

// ── Notifications (verified as this service) ───────────────────────────────
//
// Only these calls carry `Authorization: Bearer $AURA_INSTANCE_TOKEN`, so the
// shell attributes the notification to com.aura.aurashelld (sender kind
// `agent`, verified). Every other route keeps its old, token-less behaviour.
// No token → refuse rather than silently send as an anonymous caller.

/** Base wire shape (the shell's `Notification`). */
export interface NotificationWire {
  id: string;
  type: 'simple' | 'locked' | 'dialogue';
  title: string;
  text: string;
  priority: string;
  visibility: string;
  pinned: boolean;
  popup: boolean;
  /** Phase 4 (absent on older shells). */
  blocking?: boolean;
  scope?: 'auto' | 'desktop';
  state: 'active' | 'resolved' | 'removed';
  removedReason?: string;
  answer?: unknown;
  /** Phase 4: 'submitted' | 'cancelled' once resolved. */
  outcome?: 'submitted' | 'cancelled';
  context?: { kind: string; id: string; appId?: string; label?: string };
  components?: unknown[];
  /** Phase 3: the newest button click / input submit / options choice. */
  lastInteraction?: { componentId: string; kind: string; value?: string | string[]; values?: Record<string, string | string[]>; at: number };
  sender: { kind: string; id?: string; name?: string; attribution: string; actor?: { name: string; attribution: string } };
  senderKey: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  removedAt?: number;
  [k: string]: unknown;
}
export interface NotificationWarningWire { code: string; field: string; message: string; from?: unknown; to?: unknown }

/** Long-poll ceiling of GET /api/notifications/<id>?waitFor=resolved. */
export const WAIT_MAX_S = 25;

function authed(init: RequestInit = {}): RequestInit {
  const token = process.env['AURA_INSTANCE_TOKEN'];
  if (!token) {
    throw new ShellApiError(401, 'this service has no AURA_INSTANCE_TOKEN in its env, so it cannot send verified notifications — restart com.aura.aurashelld');
  }
  return { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } };
}

const nid = (id: string) => encodeURIComponent(id);

export const createNotification = (body: Record<string, unknown>) =>
  call<{ notification: NotificationWire; warnings: NotificationWarningWire[]; senderToken?: string }>('/api/notifications', authed(jsonInit('POST', body)));
export const updateNotification = (id: string, patch: Record<string, unknown>) =>
  call<{ notification: NotificationWire; warnings: NotificationWarningWire[] }>(`/api/notifications/${nid(id)}`, authed(jsonInit('PATCH', patch)));
export const removeNotification = (id: string) =>
  call<NotificationWire>(`/api/notifications/${nid(id)}/remove`, authed(jsonInit('POST', {})));
export const getNotification = (id: string) =>
  call<NotificationWire>(`/api/notifications/${nid(id)}`, authed());
export function listNotifications(q: { state?: string; limit?: number; cursor?: string } = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) qs.set(k, String(v));
  const s = qs.toString();
  return call<{ items: NotificationWire[]; nextCursor?: string }>(`/api/notifications${s ? `?${s}` : ''}`, authed());
}
/** Bounded long-poll: answers when it is resolved / removed, or after `timeoutS` (≤ 25) with the active item. */
export function waitForNotification(id: string, timeoutS: number, opts: { interactionAfter?: number } = {}) {
  const t = Math.max(0, Math.min(WAIT_MAX_S, Math.floor(timeoutS)));
  // Phase 6: `interactionAfter` also wakes on a user interaction newer than that (ms).
  const q = opts.interactionAfter !== undefined
    ? `waitFor=interaction&after=${Math.max(0, Math.floor(opts.interactionAfter))}&timeout=${t}`
    : `waitFor=resolved&timeout=${t}`;
  // The default 10 s transport timeout would cut the long-poll; give it the wait plus slack.
  return call<NotificationWire>(`/api/notifications/${nid(id)}?${q}`, authed(), (t + 10) * 1000);
}

// ── The browser ─────────────────────────────────────────────────────────────

export type UiOutcome<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: 'no-ui' | 'timeout' | 'ui-error' | 'unreachable'; message: string };

export const NO_UI_MESSAGE = 'no shell UI is connected — this needs the AuraOS shell open in a browser';

/** Run a command in the shell's browser UI and get its answer. Never throws. */
export async function ui<T = unknown>(action: string, params?: Record<string, unknown>, timeoutMs = 8_000): Promise<UiOutcome<T>> {
  let res: Response;
  try {
    res = await fetchImpl(`${OS_BASE}/api/os/ui/command`,
      { ...jsonInit('POST', { action, params, timeoutMs }), signal: AbortSignal.timeout(timeoutMs + 3_000) });
  } catch (err) {
    return { ok: false, error: 'unreachable', message: `the OS API at ${OS_BASE} is not reachable: ${(err as Error).message}` };
  }
  const body = await res.json().catch(() => ({})) as { ok?: boolean; result?: T; error?: string; message?: string };
  if (res.ok && body.ok) return { ok: true, result: body.result as T };
  const error = body.error === 'no-ui' || body.error === 'timeout' || body.error === 'ui-error' ? body.error : 'ui-error';
  return { ok: false, error, message: body.message ?? body.error ?? `HTTP ${res.status} from the UI command channel` };
}

/** True when the browser simply isn't there — the case with a server-side fallback. */
export const noUi = (o: UiOutcome): o is Extract<UiOutcome, { ok: false }> => !o.ok && o.error === 'no-ui';
