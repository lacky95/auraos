import type { APIRoute } from 'astro';
import {
  OsEventBus, ThemeManager, appStorageNamespace, isUserPrefKey, legacyAppNamespace, userPrefsNamespace,
  type ColorMode,
} from '@aura/core';
import { isValidKey, isValidNamespace, type KvNamespace } from '@aura/kv-store';
import { requestUserId } from '../../../lib/userContext.js';
import { sharedKv } from '../../../lib/sharedKv.js';
import { withEtag } from '../../../lib/etag.js';
import { failureResponse } from '../../../lib/appResponse.js';

/**
 * OS-wide key-value store proxy.
 *
 * URL shape:
 *   /api/kv/os/<key>             → OS-wide config (theme, workspaces, …)
 *   /api/kv/app/<appId>/<key>    → per-app private bucket
 *
 * GET    returns `{ value, updatedAt }` (404 if absent).
 * PUT    body `{ value }` writes; emits `kv:changed` on the OS event bus.
 *        Optional `ifUpdatedAt` (the `updatedAt` the edit is based on):
 *        when the stored value is newer, nothing is written and the answer
 *        is 409 `{ error, current: { value, updatedAt } }`.
 * DELETE removes the key; same event with `value: null`.
 *
 * Per user (D46). The user is the verified caller's (lib/userContext.ts),
 * never something the request names:
 *   • `os/<pref>` for a per-user preference (core `USER_PREF_KEYS`: theme,
 *     locale, keymap, workspaces, app-mru, session, lastWindow) is the caller's own
 *     `user/<userId>/prefs:<pref>`. A read falls back to the shared `os`
 *     value from before the move, for one release; a write never touches it.
 *   • `app/<id>/<key>` is the app's storage for the caller's user,
 *     `app/<id>/u/<userId>`, falling back to the pre-D46 `app/<id>` bucket on
 *     a read. `?shared=1` is the app's storage for all its users,
 *     `app/<id>/shared` (`osClient.storage.shared`).
 *   The event names the logical address (`os`, `app/<id>`) plus `userId` or
 *   `shared`, so every subscriber keeps its filter.
 *
 * Who may read and write which key is the route access manifest's
 * (routeManifest.ts, `/api/kv/[...path]`), applied by the middleware:
 *   • `os.*`          read by the owner and any app; written by the owner, or
 *                     an app holding `system.kv.os.<topic>.write`
 *   • `app/<id>.*`    only app `<id>`, and the owner
 * An app is the verified caller (instance token or gateway claim), never a
 * Referer; that rule applies to app callers in every access mode.
 */
export const ALL: APIRoute = async ({ params, request, locals }) => {
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

  // The `context:*` namespace (Aura Context env/secrets) is OS-managed and
  // must NEVER be reachable through the public KV proxy — an app could
  // otherwise read every stored token. It is only accessible via the
  // dedicated /api/os/context API and the server-internal ContextStore.
  if (ns.startsWith('context')) {
    return jsonError('The context namespace is OS-managed and not accessible via KV', 403);
  }

  if (!isValidNamespace(ns))  return jsonError(`Invalid namespace '${ns}'`,  400);
  if (!isValidKey(key))       return jsonError(`Invalid key '${key}'`,       400);

  const namespace = ns as KvNamespace;
  const method = request.method.toUpperCase();

  const kv = sharedKv();

  try {
    // Where the caller's value lives (D46): `store` is read and written,
    // `fallback` only read. `namespace` stays the address the caller named.
    let store: KvNamespace = namespace;
    let fallback: KvNamespace | null = null;
    let scope: { userId?: string; shared?: true } = {};
    const perUserPref = namespace === 'os' && isUserPrefKey(key);
    if (perUserPref || namespace.startsWith('app/')) {
      const userId = await requestUserId(request);
      if (userId === null) return jsonError('invalid or expired credential', 401);
      const shared = namespace !== 'os' && new URL(request.url).searchParams.get('shared') === '1';
      if (perUserPref) {
        store = userPrefsNamespace(userId);
        fallback = 'os';
        scope = { userId };
      } else {
        const appId = namespace.slice('app/'.length);
        store = shared ? appStorageNamespace(appId, 'shared') : appStorageNamespace(appId, { userId });
        fallback = shared ? null : legacyAppNamespace(appId);
        scope = shared ? { shared: true } : { userId };
      }
    }
    const read = async () => (await kv.get(store, key)) ?? (fallback ? await kv.get(fallback, key) : null);

    if (method === 'GET' || method === 'HEAD') {
      const entry = await read();
      if (entry === null) return jsonError(`No value at ${namespace}:${key}`, 404);
      // ETag: unchanged values (polled config, keymap, workspaces) answer 304.
      return withEtag(request, JSON.stringify(entry), 'application/json');
    }

    if (method === 'PUT' || method === 'POST') {
      const body = await request.json().catch(() => null) as { value?: unknown; ifUpdatedAt?: unknown } | null;
      if (!body || !('value' in body)) {
        return jsonError('PUT body must be `{ "value": <json> }`', 400);
      }
      const ifUpdatedAt = typeof body.ifUpdatedAt === 'number' ? body.ifUpdatedAt : null;
      const result = await serialized(`${store}:${key}`, async () => {
        const previous = await read();
        // Optimistic concurrency (opt-in): the writer says which version its
        // edit is based on. A newer stored value means the writer's copy is
        // stale — e.g. a tab resumed after a day — and writing it would roll
        // every change since back. 409 hands the writer the current value
        // to rebase on instead.
        if (ifUpdatedAt !== null && previous && previous.updatedAt !== ifUpdatedAt) {
          return { conflict: previous } as const;
        }
        return { previous, stored: await kv.set(store, key, body.value) } as const;
      });
      if ('conflict' in result) {
        return jsonResponse({ error: `Stale write to ${namespace}:${key}`, current: result.conflict }, 409);
      }
      const { previous, stored } = result;
      OsEventBus.emit('kv:changed', {
        namespace: namespace as 'os' | `app/${string}`,
        key,
        value: stored.value,
        ...scope,
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
      // The caller's own value only: an old shared value stays for the fallback (F0).
      const removed = await kv.del(store, key);
      if (removed) {
        OsEventBus.emit('kv:changed', { namespace: namespace as 'os' | `app/${string}`, key, value: null, ...scope });
      }
      return jsonResponse({ removed });
    }

    return jsonError(`Method ${method} not supported`, 405);
  } catch (err) {
    return failureResponse({ request, locals }, err, { what: 'KV error' });
  }
};

/**
 * Run PUTs to one key one after another, so the `ifUpdatedAt` check and the
 * write can't interleave with another request's. On globalThis: a rebuilt
 * module (shell-watch) must share the queue with the old one.
 */
const g = globalThis as { __auraKvPutQueue?: Map<string, Promise<unknown>> };
const putQueue = (g.__auraKvPutQueue ??= new Map());

function serialized<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = putQueue.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  putQueue.set(id, tail);
  void tail.then(() => { if (putQueue.get(id) === tail) putQueue.delete(id); });
  return run;
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
