/**
 * `aura-interfaces` — the OS Interface Registry as an MCP server.
 *
 * The registry is the OS's phone book: apps declare what they PROVIDE (an MCP
 * server, a REST path, a WS endpoint, an event topic, a KV prefix) and what
 * they CONSUME; anyone can ask who provides what and get a dialable address.
 * This server lets an agent ask those questions. It is read-only on purpose:
 * registrations are scoped to the running instance that opens them, so a write
 * tool here could only ever register interfaces under Settings' own identity,
 * which is never what a caller means.
 *
 * Naming rule, stated once here and repeated in every tool description: apps
 * are referred to by their DISPLAY NAME (the manifest `name`, e.g. `Settings`),
 * not their package id. The registry itself only knows package ids, so this
 * module joins the two through `/api/apps` and translates in both directions.
 * Display names are free text and not unique by construction; when two
 * installed apps share one, `appNameConflict` is true on every view and the
 * caller falls back to the package id (`appId`) for that app only.
 *
 * All registry reads go through `osClient.interfaces` from the app SDK, so the
 * identity headers and the OS base URL are handled the same way as in every
 * other server-side call this app makes.
 *
 * This server is itself an entry in the registry: `app.manifest.json`
 * declares it under `provides` (kind `mcp`, address `/mcp/interfaces`), and
 * the OS materialises that declaration as a live address whenever an instance
 * of Settings is up. No runtime registration call is needed.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OsClient } from '@aura/app-sdk';
import type { ConsumerView, InterfaceKind, InterfaceView } from '@aura/app-sdk';
import { z } from 'zod';

const KINDS = ['http', 'rest', 'mcp', 'ws', 'event', 'kv'] as const satisfies readonly InterfaceKind[];

const APP_ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

/**
 * Where the OS shell is, as seen from this app's process — the same value the
 * SDK prefixes onto shell-relative URLs. Returned on every result as `baseUrl`
 * so a client can build its own OS URLs instead of stripping one off `dialUrl`.
 * Only meaningful for callers in the same network position as this app (the
 * Docker network); from the host the shell is usually http://localhost:3000.
 */
const OS_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';

const KIND_DESC =
  'Transport kind: http, rest, mcp, ws (paths on the providing app), event (an OS event topic) or kv (a KV prefix).';
const STATUS_DESC =
  'Status meanings — live: a running instance serves it and `url` is dialable; '
  + 'down: an instance holds it but has no port; '
  + 'catalog: an installed app declares it but nothing is running (it is not missing, just stopped).';
const NAME_DESC =
  'App display name (e.g. `Settings`, case-insensitive) or package id (e.g. `com.aura.settings`). '
  + 'Always use the display name; use the package id only when `appNameConflict` is true for that app.';
const REF_DESC =
  '`<app>/<name>` where `<app>` is the app display name (or package id on conflict), or a bare `<name>` to match any app.';

// ───────────────────────────── app directory ─────────────────────────────────

type AppResolution = { ok: string } | { conflict: string[] } | { unknown: true };

/** The join between the registry (package ids) and what humans call apps (display names). */
interface AppDirectory {
  /** Display name for a package id; the id itself when the app is unknown. */
  nameOf(appId: string): string;
  /** true when another installed app shares this app's display name. */
  hasConflict(appId: string): boolean;
  /** Display name (case-insensitive) or package id → package id, or why not. */
  resolveApp(nameOrId: string): AppResolution;
}

function makeDirectory(names: Map<string, string>): AppDirectory {
  // display name (lower-cased) → every app id carrying it
  const byName = new Map<string, string[]>();
  for (const [appId, name] of names) {
    const key = name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), appId]);
  }
  return {
    nameOf: (appId) => names.get(appId) ?? appId,
    hasConflict: (appId) => {
      const name = names.get(appId);
      return name !== undefined && (byName.get(name.toLowerCase())?.length ?? 0) > 1;
    },
    resolveApp: (nameOrId) => {
      // A package id is taken as-is even when unknown: the registry is the
      // authority on ids, and a catalog entry may belong to an app whose
      // manifest the directory fetch missed.
      if (APP_ID_RE.test(nameOrId)) return { ok: nameOrId };
      const ids = byName.get(nameOrId.trim().toLowerCase()) ?? [];
      if (ids.length === 1) return { ok: ids[0]! };
      if (ids.length > 1) return { conflict: ids };
      return { unknown: true };
    },
  };
}

/**
 * One GET /api/apps, the shell's flat "every installed app with its manifest"
 * endpoint. Unreachable OS → empty directory: names fall back to package ids
 * and nothing conflicts, so reads stay useful while the shell is booting
 * (same stance as the Interfaces settings page).
 */
async function loadAppDirectory(): Promise<AppDirectory> {
  const names = new Map<string, string>();
  try {
    const res = await fetch(`${OS_BASE}/api/apps`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const apps = await res.json() as Array<{ manifest?: { id?: string; name?: string } }>;
      for (const a of apps) {
        if (a.manifest?.id && a.manifest.name) names.set(a.manifest.id, a.manifest.name);
      }
    }
  } catch { /* fall through to the empty directory */ }
  return makeDirectory(names);
}

// ─────────────────────────────── shaping ─────────────────────────────────────

type Enriched = { app: string; appNameConflict: boolean }
  & InterfaceView
  & { baseUrl: string; dialUrl: string | null; upstream: InterfaceView['upstream'] | null };

/**
 * Put the display name first so it is the first thing a reader sees, and add
 * the three ways to reach the interface next to the OS's shell-relative `url`:
 *   • `baseUrl`  — the OS shell; `baseUrl + url` is what `dialUrl` is;
 *   • `dialUrl`  — absolute, fetchable from this app's network position;
 *   • `upstream` — the provider's own host:port, skipping the shell proxy.
 *     Filled in by the OS only while the interface is live; null otherwise.
 * The relative `url` alone is right inside an app iframe, but an MCP client is
 * usually neither in a browser nor inside the shell.
 */
function enrich(view: InterfaceView, dir: AppDirectory, ifaces: OsClient['interfaces']): Enriched {
  return {
    app: dir.nameOf(view.appId),
    appNameConflict: dir.hasConflict(view.appId),
    ...view,
    baseUrl: OS_BASE,
    dialUrl: ifaces.urlFor(view),
    upstream: view.upstream ?? null,
  };
}

function enrichConsumer(c: ConsumerView, dir: AppDirectory) {
  return {
    app: dir.nameOf(c.appId),
    appNameConflict: dir.hasConflict(c.appId),
    ...c,
    need: { ...c.need, ...(c.need.appId ? { appName: dir.nameOf(c.need.appId) } : {}) },
  };
}

/**
 * Tool result carrying the same payload as text (for any client) and as
 * structured content. Every result is an object with `baseUrl` first: lists
 * put their entries under `items`, single records are spread in, and "nothing
 * found" is `{ value: null }`.
 */
function result(payload: unknown): CallToolResult {
  const body = Array.isArray(payload)
    ? { baseUrl: OS_BASE, items: payload }
    : { baseUrl: OS_BASE, ...(payload === null || payload === undefined ? { value: null } : (payload as Record<string, unknown>)) };
  return {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
  };
}

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

function conflictError(nameOrId: string, ids: string[]): CallToolResult {
  return toolError(`'${nameOrId}' names ${ids.length} installed apps. Use the package id instead: ${ids.join(', ')}`);
}

/** `Whisper Service/transcribe` → { app, name }; a bare `transcribe` has no app part. */
function parseRef(ref: string): { app?: string; name: string } {
  const slash = ref.lastIndexOf('/');
  if (slash <= 0) return { name: ref.trim() };
  return { app: ref.slice(0, slash).trim(), name: ref.slice(slash + 1).trim() };
}

/** What every ref-taking tool needs: the interface name plus an optional, already-resolved app id. */
type Target =
  | { ok: true; name: string; appId?: string }
  | { ok: false; error: CallToolResult };

function resolveTarget(
  dir: AppDirectory,
  input: { ref?: string | undefined; app?: string | undefined; name?: string | undefined },
): Target {
  const parsed = input.ref ? parseRef(input.ref) : { app: input.app, name: input.name ?? '' };
  if (!parsed.name) return { ok: false, error: toolError('Pass `ref` ("<app>/<name>" or "<name>") or `name`.') };
  if (!parsed.app) return { ok: true, name: parsed.name };
  const r = dir.resolveApp(parsed.app);
  if ('conflict' in r) return { ok: false, error: conflictError(parsed.app, r.conflict) };
  if ('unknown' in r) return { ok: false, error: toolError(`No installed app is called '${parsed.app}'. Use list_interfaces to see app names.`) };
  return { ok: true, name: parsed.name, appId: r.ok };
}

// ─────────────────────────────── server ──────────────────────────────────────

export function buildInterfacesServer(): McpServer {
  const ifaces = new OsClient().interfaces;
  // One directory fetch per request at most; the transport is stateless, so
  // "per server" and "per request" are the same thing.
  let dirPromise: Promise<AppDirectory> | undefined;
  const directory = () => (dirPromise ??= loadAppDirectory());

  const server = new McpServer(
    { name: 'aura-interfaces', version: '1.1.0' },
    {
      instructions:
        'Read-only view of the AuraOS Interface Registry. Apps are referred to by display name (`app`, e.g. '
        + '`Settings`); refs are `<app>/<name>` (e.g. `Whisper Service/transcribe`) or a bare `<name>` to match '
        + 'any app. Only when `appNameConflict` is true use the package id (`appId`) for that app instead. '
        + 'Every result carries `baseUrl`, the OS shell as reachable from inside the OS network; an interface\'s '
        + '`dialUrl` is `baseUrl` + `url`, and `upstream` is the provider\'s own host:port bypassing the shell. '
        + STATUS_DESC,
    },
  );

  server.registerTool(
    'list_interfaces',
    {
      title: 'List interfaces',
      description:
        'Every interface the OS knows about — live instances first, then catalog entries for anything declared '
        + 'but not currently served. Each entry carries the providing app\'s display name (`app`) and package id '
        + '(`appId`); refer to apps by `app` unless `appNameConflict` is true. Filters are ANDed. ' + STATUS_DESC,
      inputSchema: {
        kind: z.enum(KINDS).optional().describe(KIND_DESC),
        app:  z.string().optional().describe(NAME_DESC),
        name: z.string().optional().describe('Only interfaces with this app-local name.'),
        live: z.boolean().optional().describe('true → only entries a running instance currently serves.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ kind, app, name, live }) => {
      const dir = await directory();
      let appId: string | undefined;
      if (app) {
        const r = dir.resolveApp(app);
        if ('conflict' in r) return conflictError(app, r.conflict);
        if ('unknown' in r) return result([]);      // the registry would return nothing for it too
        appId = r.ok;
      }
      const views = await ifaces.list({
        ...(kind  ? { kind }  : {}),
        ...(appId ? { appId } : {}),
        ...(name  ? { name }  : {}),
        ...(live  ? { live }  : {}),
      });
      return result(views.map((v) => enrich(v, dir, ifaces)));
    },
  );

  server.registerTool(
    'resolve_interface',
    {
      title: 'Resolve an interface',
      description:
        'The single best provider for a ref, or null when nothing provides it. Ranking: live beats down beats '
        + 'catalog, so a stopped-but-installed provider comes back with status `catalog` rather than null — '
        + '"not installed" and "not running" need different fixes. Pass either `ref` or `name` (+ optional `app`/`kind`).',
      inputSchema: {
        ref:  z.string().optional().describe(REF_DESC),
        name: z.string().optional().describe('App-local interface name; used when `ref` is omitted.'),
        app:  z.string().optional().describe(`Pin to one provider app (only with \`name\`). ${NAME_DESC}`),
        kind: z.enum(KINDS).optional().describe(KIND_DESC),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ ref, name, app, kind }) => {
      const dir = await directory();
      const t = resolveTarget(dir, { ref, app, name });
      if (!t.ok) return t.error;
      const view = await ifaces.resolve({ name: t.name, ...(t.appId ? { appId: t.appId } : {}), ...(kind ? { kind } : {}) });
      return result(view ? enrich(view, dir, ifaces) : null);
    },
  );

  server.registerTool(
    'get_interface',
    {
      title: 'Get interface details',
      description:
        'Everything the OS knows about one interface — the call to make before dialing it. Returns where to dial '
        + '(`baseUrl`, `address`, `url`, `dialUrl`, `upstream`), the contract metadata (`description`, `schema`, `permission`, '
        + '`version`), liveness (`status`, `instanceId`, `state`), which apps consume it (`consumedBy`) and which '
        + 'other apps provide the same name + kind (`otherProviders`). Resolves like resolve_interface: best provider '
        + 'first, so pass `app` or an `<app>/<name>` ref to pick a specific one. Null when nothing provides it.',
      inputSchema: {
        ref:     z.string().optional().describe(REF_DESC),
        name:    z.string().optional().describe('App-local interface name; used when `ref` is omitted.'),
        app:     z.string().optional().describe(`Pin to one provider app (only with \`name\`). ${NAME_DESC}`),
        kind:    z.enum(KINDS).optional().describe(KIND_DESC),
        version: z.string().optional().describe('Exact contract version to require, e.g. "1".'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ ref, name, app, kind, version }) => {
      const dir = await directory();
      const t = resolveTarget(dir, { ref, app, name });
      if (!t.ok) return t.error;

      const candidates = (await ifaces.list({ name: t.name, ...(t.appId ? { appId: t.appId } : {}), ...(kind ? { kind } : {}) }))
        .filter((v) => !version || v.version === version)
        .sort((a, b) => rank(a) - rank(b));
      const view = candidates[0];
      if (!view) {
        const text = `Nothing provides '${ref ?? t.name}'${version ? ` at version ${version}` : ''}.`;
        return { ...result(null), content: [{ type: 'text', text }] };
      }

      const [consumers, sameContract] = await Promise.all([
        ifaces.consumers(),
        ifaces.list({ name: view.name, kind: view.kind }),
      ]);
      const consumedBy = consumers
        .filter((c) => c.matches.includes(view.id))
        .map((c) => ({ app: dir.nameOf(c.appId), appId: c.appId, required: c.need.required, status: c.status }));
      const otherProviders = sameContract.filter((v) => v.id !== view.id).map((v) => v.id);

      return result({
        ...enrich(view, dir, ifaces),
        description: view.description ?? null,
        schema: view.schema ?? null,
        permission: view.permission ?? null,
        consumedBy,
        otherProviders,
      });
    },
  );

  server.registerTool(
    'list_consumers',
    {
      title: 'List consumers',
      description:
        'The resolution report: every interface an installed app declares it NEEDS, and whether that need is met. '
        + 'live: a running provider matches; installed: an installed app provides it but nothing is running; '
        + 'unmet: nothing installed provides it — the answer to "why does this composition not work?".',
      inputSchema: {
        app:    z.string().optional().describe(`Only needs declared by this app. ${NAME_DESC}`),
        status: z.enum(['live', 'installed', 'unmet']).optional().describe('Only needs in this state.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ app, status }) => {
      const dir = await directory();
      let appId: string | undefined;
      if (app) {
        const r = dir.resolveApp(app);
        if ('conflict' in r) return conflictError(app, r.conflict);
        if ('unknown' in r) return result([]);
        appId = r.ok;
      }
      const all = await ifaces.consumers();
      return result(
        all
          .filter((c) => (!appId || c.appId === appId) && (!status || c.status === status))
          .map((c) => enrichConsumer(c, dir)),
      );
    },
  );

  return server;
}

/** Same ranking the OS and the SDK use: lower is better. */
function rank(v: InterfaceView): number {
  if (v.status === 'live') return v.state === 'resumed' ? 0 : 1;
  if (v.status === 'down') return 2;
  return 3;
}
