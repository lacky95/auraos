/**
 * `aura-shell` — the AuraOS shell UI as one MCP server.
 *
 * An agent's remote control for the desktop: an overview in one call, apps
 * by name, workspaces and their windows, layouts, zoom, fullscreen, the lock
 * screen, the launcher, the process manager, and stopping a process behind
 * a confirmation code. Everything speaks in the words a person uses: apps
 * by display name (the id only when two share a name), workspaces by number
 * or name, windows by the name the user gave them. Ambiguity is answered
 * with candidates, never a guess.
 *
 * The daemon owns no state of its own. Reads come from the shell's HTTP API;
 * anything that lives only in the browser (zoom, panels, window names, the
 * live view list) goes through the shell's UI command channel
 * (packages/shell/src/lib/uiCommandBroker.ts) and falls back to the KV /
 * REST routes when no browser is connected — or says so plainly when there
 * is no fallback.
 *
 * Registration: `app.manifest.json` declares this server under `provides`
 * (kind `mcp`, address `/api/mcp/shell`); the OS materialises it as a live
 * address whenever this service is up. No runtime call needed.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  NO_UI_MESSAGE, closeActivity, getLockscreen, getMru, getRegion, getWorkspaces, lock, noUi, putWorkspaces,
  startApp, stopInstance, ui, unlock,
  type WorkspaceState,
} from '../shell-api.ts';
import {
  nextLayout, resolveApp, resolveLayout, resolveProcess, resolveWindow, resolveWorkspace,
  type Match, type WorkspaceSummary,
} from '../resolve.ts';
import {
  activeOf, appLabel, loadState, processes, summariseWorkspaces, windowView, workspaceLine,
  type ShellState, type UiSnapshot,
} from '../overview.ts';
import { issueChallenge, verifyChallenge } from '../challenges.ts';
import { LOOP_WINDOW_MS, dedupe, noteMutation, recordRead, rememberAnswer, stopMessage } from '../dedupe.ts';

const INSTRUCTIONS =
  'Remote control for the AuraOS shell (the desktop in the browser). Start with get_shell_overview. '
  + 'Refer to apps by their display name; an id is only needed when a result says a name is shared. '
  + 'Workspaces are addressed by number (as on the status bar, 1-based) or name; windows by the name the user '
  + 'gave them, the app name, or the viewId from list_windows. When a reference matches several things the '
  + 'result lists candidates — pick one and call again. Results that change something carry `workspace`, the '
  + 'workspace that is current afterwards. Stopping or killing a process is a two-step call with a challenge '
  + 'code: put the returned question to the user and only call again with the code once they agree. '
  + 'Anything marked "no shell UI is connected" needs the shell open in a browser. '
  + 'Call each tool ONCE per turn: an identical call within a few seconds returns the same answer marked '
  + '`deduplicated: true` — you already have it, do not repeat it. Reading the same thing over and over without '
  + 'changing anything is a loop: after a few repeats the tool stops returning data and tells you to answer.';

// ── Result helpers ──────────────────────────────────────────────────────────

function ok(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}
function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
/** Several things matched: hand back the choice, not a guess. */
function ambiguous(what: string, candidates: unknown[], hint: string): CallToolResult {
  return ok({ ambiguous: true, message: `Several ${what} match — ${hint}.`, candidates });
}
function unresolved<T>(m: Match<T>, what: string, hint: string, view: (t: T) => unknown): CallToolResult | null {
  if (m.kind === 'none') return fail(`${m.message}.`);
  if (m.kind === 'many') return ambiguous(what, m.candidates.map(view), hint);
  return null;
}

interface OwnTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  annotations: ToolAnnotations;
  run: (raw: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
}

function define<S extends z.ZodObject<z.ZodRawShape>>(opts: {
  name: string; title: string; description: string; schema: S; annotations: ToolAnnotations;
  run: (args: z.infer<S>) => CallToolResult | Promise<CallToolResult>;
}): OwnTool {
  const { $schema: _drop, ...json } = zodToJsonSchema(opts.schema, { $refStrategy: 'none' }) as Record<string, unknown>;
  return {
    name: opts.name, title: opts.title, description: opts.description,
    inputSchema: json as Tool['inputSchema'], annotations: opts.annotations,
    run: (raw) => {
      const parsed = opts.schema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        return fail(`Invalid arguments for ${opts.name}: ${issues}`);
      }
      return opts.run(parsed.data);
    },
  };
}

const READ:  ToolAnnotations = { readOnlyHint: true, idempotentHint: true };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };
const KILL:  ToolAnnotations = { readOnlyHint: false, destructiveHint: true };

// ── Shared pieces ───────────────────────────────────────────────────────────

const WS_REF = z.union([z.number().int().min(1), z.string().min(1)])
  .describe('Workspace number (1-based, as on the status bar) or name.');
const WINDOW_REF = z.string().min(1)
  .describe('The name the user gave the window, the app name, or a viewId from list_windows.');

/** The workspace that is current now — re-read, so it reflects what a call just did. */
async function currentWorkspace(state: ShellState): Promise<Record<string, unknown>> {
  const ws = await getWorkspaces();
  return workspaceLine(activeOf(ws), state.layouts) as unknown as Record<string, unknown>;
}

const wsView = (w: WorkspaceSummary) => ({ number: w.number, name: w.name });

function pickWorkspace(state: ShellState, ref: string | number | undefined): WorkspaceSummary | CallToolResult {
  if (ref === undefined) return state.active;
  const m = resolveWorkspace(state.wsSummaries, ref);
  return unresolved(m, 'workspaces', 'give the number', wsView) ?? (m as { value: WorkspaceSummary }).value;
}
const isResult = (x: unknown): x is CallToolResult => !!x && typeof x === 'object' && 'content' in (x as object);

/** Mutate the workspace blob server-side — only when no browser is there to do it. */
async function patchWorkspacesKv(mutate: (ws: WorkspaceState) => void): Promise<void> {
  const ws = await getWorkspaces();
  const next: WorkspaceState = JSON.parse(JSON.stringify(ws)) as WorkspaceState;
  mutate(next);
  await putWorkspaces(next);
}

function windowsOf(state: ShellState, w: WorkspaceSummary) {
  return state.windows.filter((x) => x.workspace?.number === w.number).map(windowView);
}

function needUi(o: { ok: false; message: string }): CallToolResult {
  return fail(o.message);
}

// ── Tools ───────────────────────────────────────────────────────────────────

const TOOLS: OwnTool[] = [
  define({
    name: 'get_shell_overview',
    title: 'Shell overview',
    description:
      'The cockpit view of the desktop, in one call. Answer the user from `summary`, `workspace` (the current one '
      + 'with its windows), `focusedWindow`, `attention` and `runningApps`; `otherWorkspaces` says what is elsewhere; '
      + '`lastUsedApps` are the dock\'s recent apps. `details` (zoom, layout, fullscreen, launcher and process-manager '
      + 'state) is there for completeness — mention it only when asked or when `attention` flags it. '
      + '`ui: "not connected"` (in details) means no browser has the shell open: window names, zoom and panel state '
      + 'are then unavailable. Call this once per turn; the answer stays valid until you change something.',
    schema: z.object({}),
    annotations: READ,
    run: async () => {
      const [state, mru, lockKv] = await Promise.all([loadState({ snapshot: true }), getMru(), getLockscreen()]);
      const snap: UiSnapshot | null = state.ui;
      const lastUsed = Object.entries(mru).sort((a, b) => b[1] - a[1]).map(([id]) => appLabel(state, id))
        .filter((n, i, arr) => arr.indexOf(n) === i).slice(0, 5);
      const running = processes(state).filter((p) => p.kind === 'app')
        .map((p) => p.app).filter((n, i, arr) => arr.indexOf(n) === i);
      const focused = state.windows.find((w) => w.focused) ?? null;
      const locked = snap?.lockScreen?.active ?? (lockKv ? (lockKv.lockAt ?? 0) > (lockKv.unlockAt ?? 0) : false);
      const here = windowsOf(state, state.active);
      const line = workspaceLine(state.active, state.layouts);
      const zoom = snap?.statusBar?.zoom.percent ?? null;

      // What a person would want pointed out — only states that are not the
      // everyday default, so an empty list means "nothing unusual".
      const attention: string[] = [];
      if (locked) attention.push('the lock screen is active');
      if (snap?.statusBar?.fullscreen) attention.push('the browser is in fullscreen');
      if (zoom !== null && zoom !== 100) attention.push(`the shell is zoomed to ${zoom}%`);
      if (snap?.launcher?.open) attention.push('the launcher is open');
      if (snap?.processManager?.open) attention.push('the process manager is open');
      if (!snap) attention.push('no shell UI is connected — window names, zoom and panels are unknown');
      const broken = processes(state).filter((p) => p.label === 'ERR').map((p) => p.app);
      if (broken.length) attention.push(`in error: ${broken.join(', ')}`);

      const windowWord = (n: number) => `${n} window${n === 1 ? '' : 's'}`;
      const summary =
        `Workspace ${line.number} "${line.name}"`
        + (focused ? ` — focused: ${focused.name ? `${focused.app} "${focused.name}"` : focused.app}` : ' — nothing focused')
        + `. ${windowWord(here.length)} here, ${running.length} app${running.length === 1 ? '' : 's'} running, `
        + `${state.wsSummaries.length} workspace${state.wsSummaries.length === 1 ? '' : 's'}.`
        + (attention.length ? ` Note: ${attention.join('; ')}.` : '');

      return ok({
        summary,
        ...(attention.length ? { attention } : {}),
        workspace: { number: line.number, name: line.name, windows: here },
        focusedWindow: focused ? windowView(focused) : null,
        runningApps: running,
        otherWorkspaces: state.wsSummaries.filter((w) => w.id !== state.active.id).map((w) => {
          const wins = state.windows.filter((x) => x.workspace?.number === w.number);
          return { number: w.number, name: w.name, windows: wins.map((x) => x.name ? `${x.app} "${x.name}"` : x.app) };
        }),
        lastUsedApps: lastUsed,
        details: {
          ui: snap ? 'connected' : 'not connected',
          layout: line.layout,
          layouts: state.layouts.map((l) => l.name),
          zoom: zoom === null ? null : `${zoom}%`,
          fullscreen: snap?.statusBar?.fullscreen ?? null,
          lockScreen: locked,
          launcher: snap?.launcher ?? null,
          processManager: snap?.processManager ?? null,
        },
      });
    },
  }),

  define({
    name: 'get_datetime',
    title: 'Current date and time',
    description:
      'The current date and time as the user sees it — in the time zone from Settings → General when one is '
      + 'set, otherwise the browser device\'s zone — with date, time, time zone, UTC offset, ISO 8601 and epoch. '
      + 'Answer the user with the readable text (e.g. "Tuesday, 8 September 2026, 23:12") and do not mention the '
      + 'time zone unless asked; `timeZone` and `zoneSource` are there for your own reference. If the zone is wrong, '
      + 'the user picks theirs in Settings → General. One call is enough: the answer is to the minute, and an '
      + 'immediate repeat returns the same reading marked `deduplicated`.',
    schema: z.object({}),
    annotations: READ,
    run: async () => {
      // Readable line first — a person's answer, no zone label — the fields behind it.
      const readable = (payload: Record<string, unknown>): CallToolResult => ({
        content: [{ type: 'text', text: `${payload['date']}, ${payload['time']}` }],
        structuredContent: payload,
      });
      const r = await ui<Record<string, unknown>>('clock', {}, 2_000);
      if (r.ok) return readable({ source: 'the user\'s browser', ...r.result });
      // No browser: the instant is the same everywhere, so the server clock
      // is exact — only the zone needs the user's setting.
      const region = await getRegion();
      const now = new Date();
      let timeZone = region.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      let locale = region.locale;
      try { new Intl.DateTimeFormat(locale, { timeZone }); }
      catch { timeZone = 'UTC'; locale = 'en-US'; }
      const offsetName = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
        .formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
      const m = /([+-])(\d{1,2})(?::?(\d{2}))?/.exec(offsetName);
      return readable({
        source: 'the OS server (no browser connected)',
        iso: now.toISOString(),
        epochMs: now.getTime(),
        local: now.toLocaleString(locale, { dateStyle: 'full', timeStyle: 'short', timeZone, hour12: region.clockFormat === '12h' }),
        date: now.toLocaleDateString(locale, { dateStyle: 'full', timeZone }),
        time: now.toLocaleTimeString(locale, { timeStyle: 'short', timeZone, hour12: region.clockFormat === '12h' }),
        timeZone,
        utcOffsetMinutes: m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0,
        locale,
        zoneSource: region.timeZone ? 'AuraOS setting (Settings → General)' : 'the OS server\'s own zone — set yours in Settings → General',
      });
    },
  }),

  define({
    name: 'list_apps',
    title: 'List apps',
    description:
      'Installed apps by display name, with how many instances are running. `id` appears only when two apps '
      + 'share a name — pass it to start_app then. `service: true` marks headless backends, which have no window.',
    schema: z.object({}),
    annotations: READ,
    run: async () => {
      const state = await loadState();
      return ok({
        apps: state.apps.map((a) => {
          const running = a.instances.filter((i) => !i.inPool).length;
          return {
            name: a.manifest.name,
            ...(state.nameConflicts.has(a.manifest.name.trim().toLowerCase()) ? { id: a.manifest.id } : {}),
            ...(a.manifest.componentType === 'service' ? { service: true } : {}),
            ...(a.enabled ? {} : { disabled: true }),
            running,
          };
        }),
      });
    },
  }),

  define({
    name: 'start_app',
    title: 'Start an app',
    description:
      'Open an app by name (or id) in the CURRENT workspace — exactly like clicking it in the launcher. If the '
      + 'name is shared, the result lists candidates with ids: call again with the id. Without a connected shell '
      + 'UI the backend is started but no window can appear.',
    schema: z.object({ app: z.string().min(1).describe('App display name, or id when the name is shared.') }),
    annotations: WRITE,
    run: async ({ app }) => {
      const state = await loadState();
      const m = resolveApp(state.appSummaries, app);
      const miss = unresolved(m, 'apps', 'call again with the id', (a) => ({ name: a.name, id: a.id }));
      if (miss) return miss;
      const a = (m as { value: typeof state.appSummaries[number] }).value;
      if (a.service) return fail(`${a.name} is a service: it runs in the background and has no window. See list_processes.`);
      if (!a.enabled) return fail(`${a.name} is disabled. Enable it in Settings first.`);
      const r = await ui('launchApp', { appId: a.id, workspaceId: state.active.id }, 15_000);
      if (r.ok) return ok({ started: appLabel(state, a.id), workspace: await currentWorkspace(state) });
      if (!noUi(r)) return fail(r.message);
      const res = await startApp(a.id);
      return ok({
        started: appLabel(state, a.id), instanceId: res.instanceId,
        note: 'no shell UI is connected: the backend was started but no window opened',
        workspace: await currentWorkspace(state),
      });
    },
  }),

  define({
    name: 'list_workspaces',
    title: 'List workspaces',
    description: 'Workspaces in status-bar order: number, name, layout, which is active, and the windows in each.',
    schema: z.object({}),
    annotations: READ,
    run: async () => {
      const state = await loadState({ snapshot: true });
      return ok({
        current: workspaceLine(state.active, state.layouts),
        workspaces: state.wsSummaries.map((w) => ({
          ...workspaceLine(w, state.layouts), active: w.id === state.active.id, windows: windowsOf(state, w),
        })),
        ...(state.ui ? {} : { note: 'no shell UI is connected: windows are reconstructed from the OS, without names' }),
      });
    },
  }),

  define({
    name: 'switch_workspace',
    title: 'Switch workspace',
    description:
      'Make a workspace the current one, by number (1-based) or name. Names match case-insensitively and a unique '
      + 'partial name works; a shared name returns candidates with numbers.',
    schema: z.object({ workspace: WS_REF }),
    annotations: WRITE,
    run: async ({ workspace }) => {
      const state = await loadState();
      const target = pickWorkspace(state, workspace);
      if (isResult(target)) return target;
      const r = await ui('switchWorkspace', { workspaceId: target.id });
      if (!r.ok) {
        if (!noUi(r)) return fail(r.message);
        await patchWorkspacesKv((ws) => { ws.activeWorkspaceId = target.id; });
      }
      return ok({ switched: true, workspace: await currentWorkspace(state), windows: windowsOf(state, target) });
    },
  }),

  define({
    name: 'rename_workspace',
    title: 'Rename a workspace',
    description: 'Give a workspace a new name — the current one unless `workspace` names another.',
    schema: z.object({
      name: z.string().min(1).max(40).describe('The new name.'),
      workspace: WS_REF.optional(),
    }),
    annotations: WRITE,
    run: async ({ name, workspace }) => {
      const state = await loadState();
      const target = pickWorkspace(state, workspace);
      if (isResult(target)) return target;
      const r = await ui('renameWorkspace', { workspaceId: target.id, name });
      if (!r.ok) {
        if (!noUi(r)) return fail(r.message);
        await patchWorkspacesKv((ws) => { const w = ws.workspaces.find((x) => x.id === target.id); if (w) w.name = name.trim(); });
      }
      return ok({ renamed: { number: target.number, from: target.name, to: name.trim() }, workspace: await currentWorkspace(state) });
    },
  }),

  define({
    name: 'new_workspace',
    title: 'New workspace',
    description: 'Create a workspace (named `WS <n>` unless you give a name) and switch to it.',
    schema: z.object({ name: z.string().min(1).max(40).optional().describe('Name for the new workspace.') }),
    annotations: WRITE,
    run: async ({ name }) => {
      const state = await loadState();
      const r = await ui('newWorkspace', { name });
      if (!r.ok) {
        if (!noUi(r)) return fail(r.message);
        await patchWorkspacesKv((ws) => {
          const n = ws.workspaces.reduce((m, w) => Math.max(m, Number(/^ws-(\d+)$/.exec(w.id)?.[1] ?? 0)), 0) + 1;
          const id = `ws-${n}`;
          ws.workspaces.push({ id, name: name?.trim() || `WS ${n}`, layoutId: 'tiling', members: [] });
          ws.activeWorkspaceId = id;
        });
      }
      return ok({ created: true, workspace: await currentWorkspace(state) });
    },
  }),

  define({
    name: 'list_layouts',
    title: 'List layouts',
    description: 'The window layouts a workspace can use (name and what it does), and which one the current workspace has.',
    schema: z.object({}),
    annotations: READ,
    run: async () => {
      const state = await loadState();
      return ok({
        current: workspaceLine(state.active, state.layouts),
        layouts: state.layouts.map((l) => ({ name: l.name, ...(l.description ? { description: l.description } : {}) })),
      });
    },
  }),

  define({
    name: 'switch_layout',
    title: 'Switch layout',
    description:
      'Change how a workspace arranges its windows. Give a layout name (e.g. "Tiling", "Free Window") to pick one, '
      + 'or omit it to cycle to the next layout like the status-bar chip. Applies to the current workspace unless '
      + '`workspace` names another.',
    schema: z.object({
      layout: z.string().min(1).optional().describe('Layout name; omit to switch to the next one.'),
      workspace: WS_REF.optional(),
    }),
    annotations: WRITE,
    run: async ({ layout, workspace }) => {
      const state = await loadState();
      if (state.layouts.length === 0) return fail('the OS reported no layouts (GET /api/os/layouts was empty).');
      const target = pickWorkspace(state, workspace);
      if (isResult(target)) return target;
      let chosen;
      if (layout) {
        const m = resolveLayout(state.layouts, layout);
        const miss = unresolved(m, 'layouts', 'use the full name', (l) => l.name);
        if (miss) return miss;
        chosen = (m as { value: typeof state.layouts[number] }).value;
      } else {
        chosen = nextLayout(state.layouts, target.layoutId);
      }
      const r = await ui('switchLayout', { workspaceId: target.id, layoutId: chosen.id });
      if (!r.ok) {
        if (!noUi(r)) return fail(r.message);
        await patchWorkspacesKv((ws) => { const w = ws.workspaces.find((x) => x.id === target.id); if (w) w.layoutId = chosen.id; });
      }
      return ok({ layout: chosen.name, on: wsView(target), workspace: await currentWorkspace(state) });
    },
  }),

  define({
    name: 'zoom',
    title: 'Zoom the shell',
    description:
      'Zoom the whole shell UI: `in` / `out` step by 10 %, `reset` returns to 100 %, `set` uses `percent` '
      + '(50–400). Returns the effective zoom after clamping. Needs the shell open in a browser.',
    schema: z.object({
      action: z.enum(['in', 'out', 'reset', 'set']),
      percent: z.number().int().min(50).max(400).optional().describe('Target zoom for `set`.'),
    }),
    annotations: WRITE,
    run: async ({ action, percent }) => {
      if (action === 'set' && percent === undefined) return fail('`set` needs `percent` (50–400).');
      const params = action === 'in' ? { step: 1 } : action === 'out' ? { step: -1 } : action === 'reset' ? { reset: true } : { percent };
      const r = await ui<{ percent: number }>('setZoom', params);
      if (!r.ok) return needUi(r);
      return ok({ zoom: `${r.result.percent}%` });
    },
  }),

  define({
    name: 'fullscreen',
    title: 'Browser fullscreen',
    description:
      'Put the shell into, or take it out of, browser fullscreen. `off` always works. `on` and `toggle` INTO '
      + 'fullscreen usually fail: browsers only allow it from a user gesture — the result says so; ask the user '
      + 'to press F11 or the ⛶ button.',
    schema: z.object({ mode: z.enum(['on', 'off', 'toggle']) }),
    annotations: WRITE,
    run: async ({ mode }) => {
      const r = await ui<{ fullscreen: boolean }>('fullscreen', { mode });
      if (!r.ok) return needUi(r);
      return ok({ fullscreen: r.result.fullscreen });
    },
  }),

  define({
    name: 'lock_screen',
    title: 'Lock screen',
    description:
      'Show (`on`) or dismiss (`off`) the lock-screen blackout. Works even without a connected browser: the '
      + 'overlay picks the signal up within a second.',
    schema: z.object({ mode: z.enum(['on', 'off']) }),
    annotations: WRITE,
    run: async ({ mode }) => {
      const r = await ui<{ locked: boolean | null }>('lockScreen', { mode });
      if (r.ok) return ok({ locked: r.result.locked ?? (mode === 'on') });
      if (!noUi(r)) return fail(r.message);
      if (mode === 'on') await lock(); else await unlock();
      return ok({ locked: mode === 'on', note: 'signalled through the OS; any shell that opens follows within a second' });
    },
  }),

  define({
    name: 'open_launcher',
    title: 'Open the launcher',
    description: 'Open the app launcher, optionally with the search already filled in (`query`).',
    schema: z.object({ query: z.string().max(64).optional().describe('Text to put in the launcher search.') }),
    annotations: WRITE,
    run: async ({ query }) => {
      const r = await ui('openLauncher', { query });
      return r.ok ? ok(r.result as Record<string, unknown>) : needUi(r);
    },
  }),
  define({
    name: 'close_launcher',
    title: 'Close the launcher',
    description: 'Close the app launcher.',
    schema: z.object({}),
    annotations: WRITE,
    run: async () => { const r = await ui('closeLauncher'); return r.ok ? ok(r.result as Record<string, unknown>) : needUi(r); },
  }),
  define({
    name: 'search_launcher',
    title: 'Search in the launcher',
    description:
      'Type into the launcher search field, live (opens the launcher if needed), and return the apps that match. '
      + 'An empty query shows everything again.',
    schema: z.object({ query: z.string().max(64).describe('Search text; matches app names and ids.') }),
    annotations: WRITE,
    run: async ({ query }) => { const r = await ui('searchLauncher', { query }); return r.ok ? ok(r.result as Record<string, unknown>) : needUi(r); },
  }),

  define({
    name: 'open_process_manager',
    title: 'Open the process manager',
    description:
      'Open the process manager panel. `show_apps` / `show_services` set its APPS and SERVICES filters (they '
      + 'persist in that browser, like clicking the pills).',
    schema: z.object({
      show_apps: z.boolean().optional().describe('Show app processes.'),
      show_services: z.boolean().optional().describe('Show service (background) processes.'),
    }),
    annotations: WRITE,
    run: async ({ show_apps, show_services }) => {
      const r = await ui('openProcessManager', { showApps: show_apps, showServices: show_services });
      return r.ok ? ok(r.result as Record<string, unknown>) : needUi(r);
    },
  }),
  define({
    name: 'close_process_manager',
    title: 'Close the process manager',
    description: 'Close the process manager panel.',
    schema: z.object({}),
    annotations: WRITE,
    run: async () => { const r = await ui('closeProcessManager'); return r.ok ? ok(r.result as Record<string, unknown>) : needUi(r); },
  }),

  define({
    name: 'list_processes',
    title: 'List processes',
    description:
      'Running processes as the process manager shows them: app name, instance id, state (RUN, PSE, BOOT, STOP, '
      + 'TERM, OFF, ERR), pid, port, whether it is an app or a service, and its open windows (activities).',
    schema: z.object({}),
    annotations: READ,
    run: async () => {
      const state = await loadState();
      return ok({ processes: processes(state) });
    },
  }),

  define({
    name: 'stop_process',
    title: 'Stop or kill a process',
    description:
      'End a running process: `stop` runs its lifecycle hooks and exits cleanly, `kill` is an immediate SIGKILL. '
      + 'This is destructive, so it takes two calls. The first (no `challenge`) returns the process details, a '
      + 'challenge code and the question to ask the user. Once they agree, call again with the same process and '
      + 'mode plus `challenge` — within 2 minutes; the code works once.',
    schema: z.object({
      process: z.string().min(1).describe('App name or instance id, as in list_processes.'),
      mode: z.enum(['stop', 'kill']).default('stop'),
      challenge: z.string().optional().describe('The code returned by the first call.'),
    }),
    annotations: KILL,
    run: async ({ process: ref, mode, challenge }) => {
      const state = await loadState();
      const procs = processes(state);
      const m = resolveProcess(procs, ref);
      const miss = unresolved(m, 'processes', 'use the instance id', (p) => ({ app: p.app, instanceId: p.instanceId, state: p.label, kind: p.kind }));
      if (miss) return miss;
      const p = (m as { value: typeof procs[number] }).value;
      const summary = { app: p.app, instanceId: p.instanceId, state: p.label, kind: p.kind, windows: p.activities.length };
      if (!challenge) {
        const code = issueChallenge(p.instanceId, mode);
        return ok({
          challenge: code,
          process: summary,
          question: `Do you want to ${mode} ${p.app} (${p.instanceId})?`,
          next: `If the user agrees, call stop_process again with process="${p.instanceId}", mode="${mode}" and challenge="${code}" within 2 minutes.`,
        });
      }
      const v = verifyChallenge(challenge, p.instanceId, mode);
      if (!v.ok) {
        const why = v.reason === 'expired' ? 'has expired' : v.reason === 'mismatch' ? 'was issued for a different process or mode' : 'is not one I issued (or was already used)';
        return fail(`The challenge code ${why}. Call stop_process without a challenge to get a new one.`);
      }
      await stopInstance(p.instanceId, mode);
      return ok({ [mode === 'kill' ? 'killed' : 'stopped']: p.app, instanceId: p.instanceId, workspace: await currentWorkspace(state) });
    },
  }),

  define({
    name: 'list_windows',
    title: 'List windows',
    description:
      'Every open window across all workspaces: app, the name the user gave it (if any), title, viewId, workspace, '
      + 'and — with a connected browser — state and focus.',
    schema: z.object({}),
    annotations: READ,
    run: async () => {
      const state = await loadState({ snapshot: true });
      return ok({
        current: workspaceLine(state.active, state.layouts),
        windows: state.windows.map(windowView),
        ...(state.ui ? {} : { note: 'no shell UI is connected: windows are reconstructed from the OS, without names or focus' }),
      });
    },
  }),

  define({
    name: 'focus_window',
    title: 'Focus a window',
    description: 'Bring a window to the front, switching to its workspace if it lives elsewhere.',
    schema: z.object({ window: WINDOW_REF }),
    annotations: WRITE,
    run: async ({ window: ref }) => {
      const state = await loadState({ snapshot: true });
      if (!state.ui) return fail(NO_UI_MESSAGE);
      const m = resolveWindow(state.windows, ref);
      const miss = unresolved(m, 'windows', 'use the viewId', windowView);
      if (miss) return miss;
      const w = (m as { value: typeof state.windows[number] }).value;
      const r = await ui('focusWindow', { viewId: w.viewId });
      if (!r.ok) return fail(r.message);
      return ok({ focused: windowView(w), workspace: await currentWorkspace(state) });
    },
  }),

  define({
    name: 'rename_window',
    title: 'Name a window',
    description:
      'Set the label shown in a window\'s title bar — the same one the ✎ button edits. It lives in the browser '
      + 'only: gone when the window closes or the page reloads. An empty `name` clears it.',
    schema: z.object({ window: WINDOW_REF, name: z.string().max(60).describe('The label; empty to clear.') }),
    annotations: WRITE,
    run: async ({ window: ref, name }) => {
      const state = await loadState({ snapshot: true });
      if (!state.ui) return fail(NO_UI_MESSAGE);
      const m = resolveWindow(state.windows, ref);
      const miss = unresolved(m, 'windows', 'use the viewId', windowView);
      if (miss) return miss;
      const w = (m as { value: typeof state.windows[number] }).value;
      const r = await ui<{ name: string | null }>('renameWindow', { viewId: w.viewId, name });
      if (!r.ok) return fail(r.message);
      return ok({ window: { app: w.app, viewId: w.viewId }, name: r.result.name, workspace: await currentWorkspace(state) });
    },
  }),

  define({
    name: 'close_window',
    title: 'Close a window',
    description:
      'Close a window. Its backend stops too unless the app keeps running in the background. For a running '
      + 'process with no window use stop_process.',
    schema: z.object({ window: WINDOW_REF }),
    annotations: KILL,
    run: async ({ window: ref }) => {
      const state = await loadState({ snapshot: true });
      const m = resolveWindow(state.windows, ref);
      const miss = unresolved(m, 'windows', 'use the viewId', windowView);
      if (miss) return miss;
      const w = (m as { value: typeof state.windows[number] }).value;
      const r = await ui('closeWindow', { viewId: w.viewId });
      if (!r.ok) {
        if (!noUi(r)) return fail(r.message);
        if (!w.activityId) return fail(`${NO_UI_MESSAGE}; and ${w.app} has no activity to close from the OS side — use stop_process.`);
        await closeActivity(w.activityId);
      }
      return ok({ closed: windowView(w), workspace: await currentWorkspace(state) });
    },
  }),

  define({
    name: 'reload_window',
    title: 'Reload a window',
    description: 'Reload the app inside a window (like refreshing its page) without closing it.',
    schema: z.object({ window: WINDOW_REF }),
    annotations: WRITE,
    run: async ({ window: ref }) => {
      const state = await loadState({ snapshot: true });
      if (!state.ui) return fail(NO_UI_MESSAGE);
      const m = resolveWindow(state.windows, ref);
      const miss = unresolved(m, 'windows', 'use the viewId', windowView);
      if (miss) return miss;
      const w = (m as { value: typeof state.windows[number] }).value;
      const r = await ui('reloadWindow', { viewId: w.viewId });
      if (!r.ok) return fail(r.message);
      return ok({ reloaded: windowView(w), workspace: await currentWorkspace(state) });
    },
  }),
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ── Server ──────────────────────────────────────────────────────────────────

export function buildShellServer(): Server {
  const server = new Server(
    { name: 'aura-shell', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, title, description, inputSchema, annotations }): Tool =>
      ({ name, title, description, inputSchema, annotations })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = BY_NAME.get(req.params.name);
    if (!tool) return fail(`Unknown tool "${req.params.name}".`);
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    // Reading the same thing again and again, with nothing changed in
    // between, is a loop the answers themselves cannot break — so stop
    // answering with data and say so. A mutating call clears the count.
    if (tool.annotations.readOnlyHint) {
      const { count, tripped } = recordRead(tool.name);
      if (tripped) {
        const msg = stopMessage(tool.name, count, Math.round(LOOP_WINDOW_MS / 1000));
        console.warn(`[mcp] loop brake: ${tool.name} ×${count}`);
        return { content: [{ type: 'text', text: msg }] };
      }
    } else {
      noteMutation();
    }

    const { duplicate, result } = dedupe(tool.name, args, () => Promise.resolve(tool.run(args)));
    let out: CallToolResult;
    try { out = await result; }
    catch (err) { return fail(`${tool.name} failed: ${(err as Error).message}`); }
    // Keep the headline so the brake can repeat it instead of the payload.
    // `summary` first: a tool whose text is JSON would otherwise contribute
    // an opening brace as its "answer".
    const summary = out.structuredContent?.['summary'];
    const head = out.content.find((c) => c.type === 'text');
    const headline = typeof summary === 'string' ? summary
      : (head && typeof head.text === 'string' ? head.text.split('\n')[0] ?? '' : '');
    if (headline && !headline.startsWith('{')) rememberAnswer(tool.name, headline);
    if (!duplicate) return out;
    // Same call, moments ago: hand back that answer and say so, so a model
    // that repeated itself sees it already has what it asked for.
    const note = `(deduplicated: identical ${tool.name} call a moment ago — this is the same answer; no need to call again)`;
    return {
      ...out,
      content: [...out.content, { type: 'text', text: note }],
      ...(out.structuredContent ? { structuredContent: { ...out.structuredContent, deduplicated: true } } : {}),
    };
  });

  return server;
}

// Kept for the tests and for anyone counting.
export const TOOL_NAMES = TOOLS.map((t) => t.name);
// The helper the overview shares with list_workspaces; exported so tests can pin its shape.
export { summariseWorkspaces };
