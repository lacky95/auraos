import type { APIRoute } from 'astro';
import { getAppManager, OsEventBus, ThemeManager, type ColorMode } from '@aura/core';
import { defaultKv, isValidKey, isValidNamespace, type KvNamespace } from '@aura/kv-store';

/**
 * OS-wide key-value store proxy.
 *
 * URL shape:
 *   /api/kv/os/<key>             → OS-wide config (theme, workspaces, …)
 *   /api/kv/app/<appId>/<key>    → per-app private bucket
 *
 * GET    returns `{ value, updatedAt }` (404 if absent).
 * PUT    body `{ value }` writes; emits `kv:changed` on the OS event bus.
 * DELETE removes the key; same event with `value: null`.
 *
 * Permission model (see plan):
 *   • Read `os.*`               — public.
 *   • Read `app/<id>.*`         — caller must be `<id>` (Referer check)
 *                                  or hold `data:app/<id>:read`.
 *   • Write `os.<topic>`        — caller must hold `system.kv.os.<topic>.write`
 *                                  (or be `'system'` — server-side SSR).
 *   • Write `app/<id>.*`        — caller must be `<id>`.
 */
export const ALL: APIRoute = async ({ params, request }) => {
  const segments = (params['path'] ?? '').split('/').filter(Boolean);
  if (segments.length < 2) {
    return jsonError('Path must be `<namespace>/<key>` — e.g. `/api/kv/os/theme`', 400);
  }

  // First two segments form the namespace for `app/<id>`; first one only for `os`.
  let ns:  string;
  let key: string;
  if (segments[0] === 'app') {
    if (segments.length < 3) return jsonError('app namespace needs <appId>/<key>', 400);
    ns  = `app/${segments[1]}`;
    key = segments.slice(2).join('/');
  } else {
    ns  = segments[0]!;
    key = segments.slice(1).join('/');
  }

  if (!isValidNamespace(ns))  return jsonError(`Invalid namespace '${ns}'`,  400);
  if (!isValidKey(key))       return jsonError(`Invalid key '${key}'`,       400);

  const namespace = ns as KvNamespace;
  const mgr = getAppManager();
  const sourceAppId = identifySource(request.headers.get('referer'), mgr);
  const method = request.method.toUpperCase();

  // Permission gate. `'system'` (no Referer, e.g. SSR / curl) is privileged
  // and skips checks — same convention as the content-provider proxy.
  if (sourceAppId !== 'system') {
    const gate = checkPermission(namespace, key, sourceAppId, method, mgr);
    if (gate) return gate;
  }

  const kv = defaultKv();

  try {
    if (method === 'GET' || method === 'HEAD') {
      const entry = await kv.get(namespace, key);
      if (entry === null) return jsonError(`No value at ${namespace}:${key}`, 404);
      return jsonResponse(entry);
    }

    if (method === 'PUT' || method === 'POST') {
      const body = await request.json().catch(() => null) as { value?: unknown } | null;
      if (!body || !('value' in body)) {
        return jsonError('PUT body must be `{ "value": <json> }`', 400);
      }
      const previous = await kv.get(namespace, key);
      const stored = await kv.set(namespace, key, body.value);
      OsEventBus.emit('kv:changed', {
        namespace,
        key,
        value: stored.value,
      });
      // Legacy event bridges: until every consumer migrates to subscribing
      // on `kv:changed`, the well-known OS keys also re-emit the typed
      // events from before the KV refactor (`theme:changed`, `mode:changed`,
      // `workspaces:changed`). Cheap, scoped to two keys, and the prior
      // SSE subscribers Just Keep Working.
      if (namespace === 'os' && key === 'theme') {
        emitThemeOrModeChanged(stored.value, previous?.value);
      }
      if (namespace === 'os' && key === 'workspaces') {
        emitWorkspacesChanged(stored.value, previous?.value);
      }
      return jsonResponse(stored);
    }

    if (method === 'DELETE') {
      const removed = await kv.del(namespace, key);
      if (removed) {
        OsEventBus.emit('kv:changed', { namespace, key, value: null });
      }
      return jsonResponse({ removed });
    }

    return jsonError(`Method ${method} not supported`, 405);
  } catch (err) {
    return jsonError(`KV error: ${(err as Error).message}`, 500);
  } finally {
    // Each handler holds its own connection; close it after the request so
    // we don't leak sockets when the shell handles thousands of requests.
    kv.close().catch(() => undefined);
  }
};

/**
 * Returns a Response if the caller is forbidden, `null` if they may proceed.
 */
function checkPermission(
  namespace: KvNamespace,
  key:       string,
  sourceAppId: string,
  method:    string,
  mgr:       ReturnType<typeof getAppManager>,
): Response | null {
  const isRead  = method === 'GET' || method === 'HEAD';

  if (namespace === 'os') {
    if (isRead) return null;                                            // public read
    // First topic segment of the key → permission scope. e.g. key
    // `theme.colorMode` ⇒ permission `system.kv.os.theme.write`.
    const topic = key.split(/[./]/, 1)[0]!;
    const permKey = `system.kv.os.${topic}.write`;
    if (mgr.permissions.hasPermission(sourceAppId, permKey)) return null;
    return jsonError(`Permission denied: ${permKey}`, 403);
  }

  // namespace === 'app/<id>': must be the same app.
  const ownerAppId = namespace.slice(4); // strip "app/"
  if (sourceAppId === ownerAppId) return null;
  // Cross-app read can be granted later via `data:app/<id>:read`; for now
  // refuse everything but same-app.
  return jsonError(`Cross-app access to ${namespace} requires same-app caller (saw '${sourceAppId}')`, 403);
}

function identifySource(referer: string | null, mgr: ReturnType<typeof getAppManager>): string {
  if (!referer) return 'system';
  try {
    const url = new URL(referer);
    const match = url.pathname.match(/^\/api\/proxy\/([^/]+)\//);
    if (!match) return 'system';
    const idOrInstanceId = match[1]!;
    const inst = mgr.getInstance(idOrInstanceId) ?? mgr.getInstancesByApp(idOrInstanceId)[0];
    return inst?.appId ?? idOrInstanceId;
  } catch {
    return 'system';
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonError(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

interface ThemeKvShape {
  themeIdDark?:  string;
  themeIdLight?: string;
  colorMode?:    string;
}
interface WorkspaceKvShape {
  workspaces?:        Array<{ id: string; name: string; layoutId: string; memberCount?: number; members?: unknown[] }>;
  activeWorkspaceId?: string;
}

const KNOWN_MODES: readonly ColorMode[] = ['light', 'dark', 'auto'];

function emitThemeOrModeChanged(next: unknown, prev: unknown): void {
  if (!next || typeof next !== 'object') return;
  const n = next as ThemeKvShape;
  const p = (prev && typeof prev === 'object' ? prev : {}) as ThemeKvShape;
  const themeIdDark  = typeof n.themeIdDark  === 'string' ? n.themeIdDark  : ThemeManager.DEFAULT_THEME_ID_DARK;
  const themeIdLight = typeof n.themeIdLight === 'string' ? n.themeIdLight : ThemeManager.DEFAULT_THEME_ID_LIGHT;
  const colorMode    = (KNOWN_MODES.includes(n.colorMode as ColorMode) ? n.colorMode : ThemeManager.DEFAULT_COLOR_MODE) as ColorMode;
  if (!ThemeManager.getTheme(themeIdDark) || !ThemeManager.getTheme(themeIdLight)) return;
  const { theme: active, resolvedMode } = ThemeManager.resolveActiveTheme(themeIdLight, themeIdDark, colorMode);
  const themeMoved = p.themeIdDark !== themeIdDark || p.themeIdLight !== themeIdLight;
  const modeMoved  = p.colorMode   !== colorMode;
  if (themeMoved) {
    OsEventBus.emit('theme:changed', {
      themeId:      active.id,
      themeName:    active.name,
      themeIdDark,
      themeIdLight,
      colorMode,
      resolvedMode,
      activeTone:   active.tone,
      framework:    { id: active.framework.id, version: active.framework.version },
    });
  }
  if (modeMoved) {
    OsEventBus.emit('mode:changed', {
      themeId:      active.id,
      themeIdDark,
      themeIdLight,
      colorMode,
      resolvedMode,
      activeTone:   active.tone,
      framework:    { id: active.framework.id, version: active.framework.version },
    });
  }
}

function emitWorkspacesChanged(next: unknown, prev: unknown): void {
  if (!next || typeof next !== 'object') return;
  const n = next as WorkspaceKvShape;
  if (!Array.isArray(n.workspaces) || typeof n.activeWorkspaceId !== 'string') return;
  const summaries = n.workspaces.map((w) => ({
    id:          String(w.id ?? ''),
    name:        String(w.name ?? ''),
    layoutId:    String(w.layoutId ?? 'tiling'),
    memberCount: Array.isArray(w.members) ? w.members.length : 0,
  }));
  const prevActive = (prev && typeof prev === 'object' ? (prev as WorkspaceKvShape).activeWorkspaceId : undefined);
  OsEventBus.emit('workspaces:changed', {
    workspaces:        summaries,
    activeWorkspaceId: n.activeWorkspaceId,
  });
  if (prevActive !== undefined && prevActive !== n.activeWorkspaceId) {
    OsEventBus.emit('workspace:activated', { workspaceId: n.activeWorkspaceId });
  }
}
