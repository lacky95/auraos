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
  getTheme, setColorMode, startApp, stopInstance, ui, unlock,
  createNotification, updateNotification, removeNotification, getNotification, listNotifications,
  waitForNotification, ShellApiError, WAIT_MAX_S,
  type ColorMode, type WorkspaceState, type NotificationWire, type NotificationWarningWire,
} from '../shell-api.ts';
import {
  nextLayout, resolveApp, resolveLayout, resolveProcess, resolveViewport, resolveWindow, resolveWorkspace,
  type Match, type ViewportProfileSummary, type WorkspaceSummary,
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
  + 'Viewport profiles (named zoom/margin/theme presets) belong to the browser that has the shell open: '
  + 'get_viewport_info shows them, set_viewport switches by name. set_light_mode / set_dark_mode switch the '
  + 'whole OS and work without a browser. '
  + 'Anything marked "no shell UI is connected" needs the shell open in a browser. '
  + 'Notifications: asking is not interrupting. To ask the user something, create_notification with type '
  + '"dialogue" (buttons / options / an input; a `markdown` component shows a report) and a `context` (the task, activity or installation it is '
  + 'about), then KEEP WORKING and check back with wait_for_answer (a bounded wait, ≤ 25 s per call; '
  + '"pending" means call it again later; interactions: true also returns button clicks / input submits while it stays open) or get_notification. Prefer normal dialogues: pop-ups (`popup`) '
  + 'and Locked notifications need permissions an admin granted to this service — without them they are '
  + 'downgraded and the result says so in `warnings`. Pass your name as `agent` so the user sees who asks '
  + '(display only, never a permission). Remove your notification with remove_notification when the task is done. '
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

/** Per-call context from the transport. */
export interface CallCtx {
  /** Self-declared caller name (x-aura-agent / user-agent header). Display + audit only. */
  agentHeader?: string;
}

interface OwnTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  annotations: ToolAnnotations;
  /** false: skip duplicate absorption and the read-loop brake (waiting tools are MEANT to be repeated). */
  guard?: boolean;
  run: (raw: Record<string, unknown>, ctx: CallCtx) => CallToolResult | Promise<CallToolResult>;
}

function define<S extends z.ZodObject<z.ZodRawShape>>(opts: {
  name: string; title: string; description: string; schema: S; annotations: ToolAnnotations; guard?: boolean;
  run: (args: z.infer<S>, ctx: CallCtx) => CallToolResult | Promise<CallToolResult>;
}): OwnTool {
  const { $schema: _drop, ...json } = zodToJsonSchema(opts.schema, { $refStrategy: 'none' }) as Record<string, unknown>;
  return {
    name: opts.name, title: opts.title, description: opts.description,
    inputSchema: json as Tool['inputSchema'], annotations: opts.annotations,
    ...(opts.guard === false ? { guard: false } : {}),
    run: (raw, ctx) => {
      const parsed = opts.schema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        return fail(`Invalid arguments for ${opts.name}: ${issues}`);
      }
      return opts.run(parsed.data, ctx);
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

/**
 * One moment, phrased the four ways a person asks for it. Built here rather
 * than in the browser so both paths (browser clock, server fallback) word it
 * identically — given the zone, the locale and the clock format, the instant
 * is all that is left to differ.
 */
function phrasings(epochMs: number, timeZone: string, locale: string, hour12: boolean) {
  const at = new Date(epochMs);
  const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone, ...opts }).format(at);
  const date = fmt({ dateStyle: 'full' });
  const time = fmt({ hour: '2-digit', minute: '2-digit', hour12 });
  const timeWithSeconds = fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12 });
  // Intl says "GMT+2"; everyone else says "UTC+2". Normalise once, here, so
  // the field and the sentence can never disagree.
  const offset = (new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
    .formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT')
    .replace(/^GMT$/, 'UTC+0').replace(/^GMT/, 'UTC');
  return {
    time,
    date,
    dateTime: `${date}, ${time}`,
    full: `${date} at ${timeWithSeconds}, ${timeZone} (${offset})`,
    timeWithSeconds,
    offset,
  };
}

/** How to speak a time — the rule the model should follow. */
const SAY_RULE =
  'Say back only what was asked: the time alone → `say.time`; the date alone → `say.date`; both '
  + '("date and time", "time and date", "datetime") → `say.dateTime`; "full time" or "full date" → `say.full`. '
  + 'Word it like a person would; never read out the ISO string, the epoch or the offset unless the user asks '
  + 'for them. Everything precise is under `technical`.';

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

/** What the browser answers to `getViewportInfo` (StatusBar.astro). */
interface ViewportInfo {
  active: ViewportProfileSummary & {
    zoomPercent: number; shellZoomPercent: number; appZoomPercent: number;
    margins: { top: number; right: number; bottom: number; left: number };
    themeIdLight: string; themeIdDark: string;
  };
  profiles: ViewportProfileSummary[];
}

/** set_light_mode / set_dark_mode — one KV write, so no browser needed. */
function colorModeTool(mode: Exclude<ColorMode, 'auto'>): OwnTool {
  return define({
    name: `set_${mode}_mode`,
    title: `${mode === 'light' ? 'Light' : 'Dark'} mode`,
    description:
      `Switch the whole AuraOS shell, and every app in it, to ${mode} mode. Keeps the chosen light and dark `
      + 'themes; every open shell re-themes at once. Works without a browser. The result says the mode before '
      + 'and after.',
    schema: z.object({}),
    annotations: WRITE,
    run: async () => {
      const { from, to } = await setColorMode(mode);
      return ok({ colorMode: to, from, ...(from === to ? { note: `already in ${to} mode` } : {}) });
    },
  });
}

// ── Tools ───────────────────────────────────────────────────────────────────

// ── Notifications ───────────────────────────────────────────────────────────
//
// Sent as THIS service (Bearer $AURA_INSTANCE_TOKEN → sender kind `agent`,
// verified). The calling agent's name is display metadata only
// (`sender.actor`, unverified): it never changes what is allowed — that is
// decided by this service's own manifest permissions and admin grants.

const NOTIF_ID = z.string().regex(/^ntf_[a-z0-9]{9,20}$/, 'a notification id (ntf_…) from create_notification / list_notifications');
const AGENT = z.string().min(1).max(100).optional()
  .describe('Your name as the user should see it (e.g. "Claude Code"). Display only — never a permission.');
const COMPONENT = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('button'), id: z.string().optional(), label: z.string().optional(), variant: z.enum(['primary', 'secondary', 'tertiary']).optional(),
    action: z.enum(['resolve', 'dismiss', 'link']).optional(),
    role: z.enum(['submit', 'cancel', 'later']).optional().describe('Standard dialogue button: submit (answer outcome "submitted"), cancel ("cancelled"), later (user postpones; nothing is sent). Label / id optional for these; the shell adds missing ones.'),
    href: z.string().optional() }),
  z.object({ kind: z.literal('options'), id: z.string(), label: z.string().optional(), multiple: z.boolean().optional(),
    display: z.enum(['segmented', 'radio', 'checkbox']).optional().describe('segmented (single choice chips, default, ≤ 4 options) · radio (single choice vertical list, ≤ 8) · checkbox (multiple: true — its only display, ≤ 8).'),
    options: z.array(z.object({ id: z.string(), label: z.string(), description: z.string().max(200).optional().describe('Shown under the label in radio / checkbox lists.') })).min(1).max(8) }),
  z.object({ kind: z.literal('input'), id: z.string(), label: z.string().optional(), placeholder: z.string().optional(),
    multiline: z.boolean().optional(), required: z.boolean().optional() }),
  z.object({ kind: z.literal('select'), id: z.string(), label: z.string().optional(), placeholder: z.string().optional(),
    required: z.boolean().optional(), default: z.string().optional().describe('Preselected option id.'),
    options: z.array(z.object({ id: z.string(), label: z.string() })).min(1).max(50) })
    .describe('Dropdown: one choice out of up to 50 options. The answer value is the option id.'),
  z.object({ kind: z.literal('combobox'), id: z.string(), label: z.string().optional(), placeholder: z.string().optional(),
    required: z.boolean().optional(), allowCustom: z.boolean().optional().describe('Also accept the typed text itself (≤ 200 chars) as the answer.'),
    default: z.string().optional(), options: z.array(z.object({ id: z.string(), label: z.string() })).max(50) })
    .describe('Searchable select: the user types to filter up to 50 options. The answer value is an option id, or the free text with allowCustom.'),
  z.object({ kind: z.literal('markdown'), id: z.string(), label: z.string().optional(), text: z.string().max(65_536),
    view: z.enum(['rendered', 'source']).optional(), editable: z.boolean().optional().describe('Let the user edit it; the text comes back in answer.values[id].'),
    required: z.boolean().optional(), maxHeight: z.union([z.literal('auto'), z.number().int().min(80).max(4000)]).optional() })
    .describe('A markdown document (≤ 64 KB, ≤ 2 per notification): show the user a report / summary / log. Rendered safely (no HTML, http(s) links only) with Source + Copy.'),
  z.object({ kind: z.literal('progress'), id: z.string().optional(), value: z.number().min(0).max(1).nullable(), label: z.string().optional() }),
]);
/** Options display rules (checked here so the agent gets the reason before sending). */
function refineComponents(list: Array<z.infer<typeof COMPONENT>>, ctx: z.RefinementCtx): void {
  if (list.filter((c) => c.kind === 'markdown').length > 2) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at most 2 markdown components per notification' });
  list.forEach((c, i) => {
    if (c.kind !== 'options') return;
    const d = c.display ?? (c.multiple ? 'checkbox' : 'segmented');
    if (c.multiple && d !== 'checkbox') ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'display'], message: "with multiple: true the display is 'checkbox'" });
    if (!c.multiple && d === 'checkbox') ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'display'], message: "display 'checkbox' needs multiple: true" });
    if (d === 'segmented' && c.options.length > 4) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'options'], message: "segmented allows at most 4 options — use display 'radio' for up to 8" });
  });
}
const CONTEXT = z.object({
  kind: z.enum(['activity', 'instance', 'task', 'installation', 'app', 'custom']),
  id: z.string().min(1).max(200),
  appId: z.string().max(200).optional(),
  label: z.string().max(200).optional(),
}).describe('What the notification is about (separate from you, the sender), so the shell can offer "Go to task".');
const CONTENT = {
  title: z.string().min(1).max(200),
  text: z.string().max(4000).optional().describe('Short description; links allowed.'),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  visibility: z.enum(['public', 'private', 'secret']).optional().describe('Lock-screen visibility; default private.'),
  publicTitle: z.string().max(200).optional(),
  publicText: z.string().max(4000).optional(),
  icon: z.string().max(2048).optional(),
  image: z.string().max(2048).optional(),
  pinned: z.boolean().optional(),
  popup: z.boolean().optional().describe('Dialogue only: open as a pop-up. Needs an admin grant (max 3 per 10 minutes); otherwise turned off with a warning.'),
  blocking: z.boolean().optional().describe('Dialogue only. With scope "auto": make the sender\'s OWN window inert (agents have none → turned off). With scope "system": a system modal that blocks the WHOLE shell — only if an admin granted notifications.systemModal to this service; else downgraded with a warning. The user can always force-hide it.'),
  scope: z.enum(['auto', 'system', 'desktop']).optional().describe('Dialogue only: "system" opens at once — with blocking: true as a system modal that needs the notifications.systemModal grant (shown as "Requested by <this service>", never as AuraOS; popup is irrelevant); without blocking as a system dialog (centred) that needs the popup (or systemModal) grant. "desktop" is the deprecated old name of "system".'),
  maximized: z.boolean().optional().describe('Start the dialogue maximized (e.g. long markdown reports). A hint: the user can restore it; ignored on the phone.'),
  timeoutMs: z.number().int().positive().optional().describe('Remove automatically after this many ms. Default: stays until handled.'),
  popupDurationMs: z.number().int().max(86_400_000).optional().describe('How long the pop-up shows, in ms (not the lifetime — that is timeoutMs). > 0: hide after that long, the item stays in the list. 0 or -1: the pop-up stays until the user handles it. Default: 8 s (high / urgent stay). Ignored for activity-linked items (context = the sender\'s own window): those pop-ups are sticky.'),
  components: z.array(COMPONENT).max(8).superRefine(refineComponents).optional().describe('Buttons (≤ 3 shown), options (chips ≤ 4, or display radio / checkbox lists ≤ 8, with descriptions), select (dropdown, ≤ 50), combobox (searchable, ≤ 50, optional free text), an input, markdown (a report up to 64 KB, ≤ 2), or progress.'),
  context: CONTEXT.optional(),
};

/** What an agent needs of a notification — not the full history. */
function notifView(n: NotificationWire) {
  return {
    id: n.id, type: n.type, title: n.title, state: n.state, priority: n.priority, popup: n.popup,
    ...(n.blocking ? { blocking: true } : {}),
    ...(n.scope && n.scope !== 'auto' ? { scope: n.scope } : {}),
    ...((n as { maximized?: boolean }).maximized ? { maximized: true } : {}),
    ...(n.context ? { context: n.context } : {}),
    ...(n.state === 'resolved' ? { answer: n.answer ?? null, outcome: n.outcome ?? 'submitted' } : {}),
    ...(n.removedReason ? { removedReason: n.removedReason } : {}),
    ...(n.lastInteraction ? { lastInteraction: interactionView(n.lastInteraction) } : {}),
    sender: { kind: n.sender.kind, id: n.sender.id, attribution: n.sender.attribution, ...(n.sender.actor ? { actor: n.sender.actor } : {}) },
    createdAt: new Date(n.createdAt).toISOString(),
  };
}

function interactionView(li: NonNullable<NotificationWire['lastInteraction']>) {
  return {
    componentId: li.componentId, kind: li.kind,
    ...(li.value !== undefined ? { value: li.value } : {}),
    ...(li.values ? { values: li.values } : {}),
    at: li.at,
  };
}

function warningsView(ws: NotificationWarningWire[]) {
  return ws.map((w) => ({ code: w.code, field: w.field, message: w.message }));
}

function headline(verb: string, n: NotificationWire, ws: NotificationWarningWire[]): string {
  const down = ws.filter((w) => w.code === 'downgraded');
  const extra = down.length ? ` — DOWNGRADED (${down.map((w) => `${w.field}: ${String(w.from)} → ${String(w.to)}`).join(', ')}); see warnings` : '';
  return `${verb} ${n.type} notification ${n.id} "${n.title}"${extra}`;
}

/** The declared actor: the tool argument wins, then the header. Never verified. */
function actorOf(arg: string | undefined, ctx: CallCtx) {
  const name = (arg ?? ctx.agentHeader)?.trim();
  return name ? { actor: { name: name.slice(0, 100) } } : {};
}

function notifError(err: unknown): CallToolResult {
  if (err instanceof ShellApiError) {
    if (err.status === 404) return fail('No such notification (or it was not sent by this service). Use list_notifications.');
    if (err.status === 403) return fail(`Refused: ${err.message}`);
    if (err.status === 409) return fail(`Not possible in its current state: ${err.message}`);
    if (err.status === 429) return fail(`${err.message}. Slow down — reuse or update an existing notification instead of creating new ones.`);
    return fail(err.message);
  }
  return fail((err as Error).message);
}

const NOTIFICATION_TOOLS: OwnTool[] = [
  define({
    name: 'create_notification',
    title: 'Create a notification',
    description: 'Show the user a notification, sent as the Shell Daemon (verified) with you as the display actor. '
      + 'type "dialogue" asks something (buttons / options / input) — it stays in the notification list until answered, '
      + 'To show a report / summary / log, add a `markdown` component (≤ 64 KB; rendered safely, the user can view the source, copy it and maximize the dialogue). '
      + 'so keep working and check back with wait_for_answer. Set `context` to what it is about. '
      + '"locked" (cannot be dismissed) and `popup` need admin-granted permissions; without them they are downgraded and '
      + '`warnings` explains it. Agents have no window, so plain `blocking` is downgraded; a desktop-wide modal '
      + '(`scope:"system"` + `blocking:true`) needs the admin-granted notifications.systemModal for this service, is shown '
      + 'as requested by the Shell Daemon (never as AuraOS) and can always be force-hidden by the user. If the user force-removes a Locked notification, wait_for_answer / '
      + 'get_notification report removedReason "force-removed". Returns the id.',
    schema: z.object({ type: z.enum(['simple', 'dialogue', 'locked']).default('simple'), ...CONTENT, agent: AGENT }),
    annotations: WRITE,
    run: async ({ agent, ...input }, ctx) => {
      try {
        const r = await createNotification({ ...input, sender: actorOf(agent, ctx) });
        const n = r.notification;
        return ok({
          summary: headline('Created', n, r.warnings),
          notification: notifView(n),
          warnings: warningsView(r.warnings),
          ...(n.type === 'dialogue' ? { next: `Keep working; call wait_for_answer with id ${n.id} to collect the answer.` } : {}),
        });
      } catch (err) { return notifError(err); }
    },
  }),

  define({
    name: 'update_notification',
    title: 'Update a notification',
    description: 'Change one of YOUR notifications (title, text, progress component, context, priority, …). '
      + '`null` clears an optional field. Its type cannot change. Only notifications this service created can be updated.',
    schema: z.object({
      id: NOTIF_ID,
      title: CONTENT.title.optional(),
      text: z.string().max(4000).optional(),
      priority: CONTENT.priority,
      visibility: CONTENT.visibility,
      pinned: CONTENT.pinned,
      popup: CONTENT.popup,
      blocking: CONTENT.blocking,
      scope: CONTENT.scope,
      maximized: CONTENT.maximized,
      icon: z.string().max(2048).nullable().optional(),
      image: z.string().max(2048).nullable().optional(),
      timeoutMs: z.number().int().positive().nullable().optional(),
      popupDurationMs: z.number().int().max(86_400_000).nullable().optional().describe('Pop-up display time (see create_notification); null = default.'),
      components: z.array(COMPONENT).max(8).superRefine(refineComponents).nullable().optional(),
      context: CONTEXT.nullable().optional(),
      agent: AGENT,
    }),
    annotations: WRITE,
    run: async ({ id, agent, ...patch }, ctx) => {
      try {
        const actor = actorOf(agent, ctx);
        const r = await updateNotification(id, { ...patch, ...(actor.actor ? { sender: actor } : {}) });
        return ok({ summary: headline('Updated', r.notification, r.warnings), notification: notifView(r.notification), warnings: warningsView(r.warnings) });
      } catch (err) { return notifError(err); }
    },
  }),

  define({
    name: 'remove_notification',
    title: 'Remove a notification',
    description: 'Take one of YOUR notifications away because it is no longer needed (task done, question obsolete). '
      + 'Recorded as removed by the sender (reason "completed").',
    schema: z.object({ id: NOTIF_ID }),
    annotations: WRITE,
    run: async ({ id }) => {
      try {
        const n = await removeNotification(id);
        return ok({ summary: `Removed notification ${n.id} "${n.title}"`, notification: notifView(n) });
      } catch (err) { return notifError(err); }
    },
  }),

  define({
    name: 'list_notifications',
    title: 'List my notifications',
    description: 'The notifications this service sent (newest first): id, type, state, context and — for answered dialogues — the answer. '
      + 'state: active (default), resolved, removed or all.',
    schema: z.object({
      state: z.enum(['active', 'resolved', 'removed', 'all']).default('active'),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    annotations: READ,
    run: async ({ state, limit }) => {
      try {
        const r = await listNotifications({ state, limit });
        return ok({ summary: `${r.items.length} ${state === 'all' ? '' : `${state} `}notification(s)`, notifications: r.items.map(notifView), ...(r.nextCursor ? { more: true } : {}) });
      } catch (err) { return notifError(err); }
    },
  }),

  define({
    name: 'get_notification',
    title: 'Get a notification',
    description: 'One of YOUR notifications by id: its state, and the answer once the user resolved the dialogue. '
      + 'To wait for an answer use wait_for_answer instead of calling this repeatedly.',
    schema: z.object({ id: NOTIF_ID }),
    annotations: READ,
    run: async ({ id }) => {
      try {
        const n = await getNotification(id);
        return ok({ summary: `Notification ${n.id} is ${n.state}`, notification: notifView(n) });
      } catch (err) { return notifError(err); }
    },
  }),

  define({
    name: 'wait_for_answer',
    title: 'Wait for an answer',
    description: `Wait (at most timeoutSeconds, ≤ ${WAIT_MAX_S}, default 20) until the user answers one of YOUR dialogue notifications. `
      + 'Returns status "resolved" with the answer and outcome ("submitted" / "cancelled"), "removed" (dismissed / expired), or "pending" — then do other work and call again later. '
      + 'With interactions: true it also returns status "interaction" as soon as the user clicks a button without an action, submits an input or picks an option '
      + 'while the notification stays open (`interaction` = {componentId, kind, value?, values?, at}); pass that `at` as `after` on the next call so none is missed '
      + '(default: only interactions after this call starts). It never blocks longer than the timeout.',
    schema: z.object({
      id: NOTIF_ID,
      timeoutSeconds: z.number().int().min(0).max(WAIT_MAX_S).default(20),
      interactions: z.boolean().optional().describe('Also return on the next user interaction (button / input / option) — not only on the final answer.'),
      after: z.number().int().min(0).optional().describe('With interactions: only interactions newer than this `at` (ms) count — use the `at` of the last one you handled.'),
    }),
    annotations: READ,
    guard: false,
    run: async ({ id, timeoutSeconds, interactions, after }) => {
      try {
        let baseline: number | undefined;
        if (interactions) {
          baseline = after ?? (await getNotification(id)).lastInteraction?.at ?? 0;
        } else if (after !== undefined) {
          return fail('`after` only applies with interactions: true');
        }
        const n = await waitForNotification(id, timeoutSeconds, baseline !== undefined ? { interactionAfter: baseline } : {});
        if (n.state === 'resolved') {
          const outcome = n.outcome ?? 'submitted';
          return ok({ summary: `${outcome === 'cancelled' ? 'Cancelled by the user' : 'Answered'}: ${n.id} "${n.title}"`, status: 'resolved', outcome, answer: n.answer ?? null, notification: notifView(n) });
        }
        if (n.state === 'removed') {
          return ok({ summary: `No answer: ${n.id} was removed (${n.removedReason ?? 'removed'})`, status: 'removed', removedReason: n.removedReason ?? null, notification: notifView(n) });
        }
        const li = n.lastInteraction;
        if (baseline !== undefined && li && li.at > baseline) {
          return ok({
            summary: `The user used "${li.componentId}" (${li.kind}) on ${n.id} "${n.title}" — still open`,
            status: 'interaction',
            interaction: interactionView(li),
            notification: notifView(n),
            next: `Handle it, then call wait_for_answer for ${n.id} with interactions: true and after: ${li.at} for the next one.`,
          });
        }
        return ok({
          summary: `Still pending after ${timeoutSeconds}s: ${n.id} "${n.title}"`,
          status: 'pending',
          notification: notifView(n),
          next: `Not answered yet. Continue with other work and call wait_for_answer for ${n.id} again later`
            + (baseline !== undefined ? ` (interactions: true, after: ${baseline}).` : '.'),
        });
      } catch (err) { return notifError(err); }
    },
  }),
];

const TOOLS: OwnTool[] = [
  define({
    name: 'get_shell_overview',
    title: 'Shell overview',
    description:
      'The cockpit view of the desktop, in one call. Answer the user from `summary`, `workspace` (the current one '
      + 'with its windows), `focusedWindow`, `attention` and `runningApps`; `otherWorkspaces` says what is elsewhere; '
      + '`lastUsedApps` are the dock\'s recent apps. `details` (zoom, viewport profile, light/dark mode, layout, fullscreen, launcher and process-manager '
      + 'state) is there for completeness — mention it only when asked or when `attention` flags it. '
      + '`ui: "not connected"` (in details) means no browser has the shell open: window names, zoom and panel state '
      + 'are then unavailable. Call this once per turn; the answer stays valid until you change something.',
    schema: z.object({}),
    annotations: READ,
    run: async () => {
      const [state, mru, lockKv, theme] = await Promise.all([
        loadState({ snapshot: true }), getMru(), getLockscreen(), getTheme().catch(() => null),
      ]);
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
          viewport: snap?.viewport?.activeProfile ?? null,
          colorMode: theme ? theme.colorMode ?? 'dark' : null,
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
      'The current date and time as the user sees it — in the time zone from Settings → General when one is set, '
      + 'otherwise the browser device\'s zone. `say` holds the sentence to use for each way of asking (time, '
      + 'date, both, full) and `summary` states the rule; `technical` holds the precise values (seconds, ISO, '
      + 'epoch, zone, offset) for your own use. ' + SAY_RULE
      + ' If the zone is wrong, the user picks theirs in Settings → General. One call is enough: the answer is to '
      + 'the second, and an immediate repeat returns the same reading marked `deduplicated`.',
    schema: z.object({}),
    annotations: READ,
    run: async () => {
      const [clock, region] = await Promise.all([ui<Record<string, unknown>>('clock', {}, 2_000), getRegion()]);
      const hour12 = region.clockFormat === '12h';
      const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

      // The browser knows where the user is; the server only knows the
      // setting. Either way the instant is the same — only the zone differs.
      const fromUi = clock.ok ? clock.result : null;
      let timeZone = String(fromUi?.['timeZone'] ?? region.timeZone ?? '') || serverZone;
      let locale = String(fromUi?.['locale'] ?? region.locale ?? '') || 'en-GB';
      const epochMs = typeof fromUi?.['epochMs'] === 'number' ? fromUi['epochMs'] as number : Date.now();
      try { new Intl.DateTimeFormat(locale, { timeZone }); }
      catch { timeZone = 'UTC'; locale = 'en-GB'; }

      const say = phrasings(epochMs, timeZone, locale, hour12);
      const zoneSource = fromUi?.['zoneSource'] ?? (region.timeZone
        ? 'AuraOS setting (Settings → General)'
        : 'the OS server\'s own zone — set yours in Settings → General');

      const payload = {
        summary: SAY_RULE,
        say: { time: say.time, date: say.date, dateTime: say.dateTime, full: say.full },
        technical: {
          iso: new Date(epochMs).toISOString(),
          epochMs,
          timeWithSeconds: say.timeWithSeconds,
          timeZone,
          utcOffset: say.offset,
          utcOffsetMinutes: fromUi?.['utcOffsetMinutes'] ?? null,
          locale,
          clockFormat: region.clockFormat,
          source: fromUi ? 'the user\'s browser' : 'the OS server (no browser connected)',
          zoneSource,
        },
      };
      // Lead with the everyday phrasing, then the rule — a model that reads
      // only the text still has the answer and knows how to trim it.
      return {
        content: [{ type: 'text', text: `${say.dateTime}\n${SAY_RULE}\n${JSON.stringify(payload.say, null, 2)}` }],
        structuredContent: payload,
      };
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
      'Zoom the whole shell UI. `in` and `out` move one step of 10 %; `times` repeats that in a single call, so '
      + '"zoom in twice" is action "in" with times 2 and "zoom out three times" is action "out" with times 3. '
      + '`reset` returns to 100 %, `set` goes straight to `percent` (50–400). The result gives the zoom before '
      + 'and after, and says so when the limit was already reached. Needs the shell open in a browser.',
    schema: z.object({
      action: z.enum(['in', 'out', 'reset', 'set']),
      times: z.number().int().min(1).max(35).optional()
        .describe('How many 10 % steps to move for `in`/`out`. Default 1 — "zoom in twice" is 2.'),
      percent: z.number().int().min(50).max(400).optional().describe('Target zoom for `set`.'),
    }),
    annotations: WRITE,
    run: async ({ action, percent, times }) => {
      if (action === 'set' && percent === undefined) return fail('`set` needs `percent` (50–400).');
      if (times !== undefined && action !== 'in' && action !== 'out') {
        return fail(`\`times\` only applies to zoom in and out, not \`${action}\`.`);
      }
      const steps = times ?? 1;
      const params = action === 'in' ? { step: steps }
        : action === 'out' ? { step: -steps }
        : action === 'reset' ? { reset: true }
        : { percent };
      const r = await ui<{ percent: number; from?: number }>('setZoom', params);
      if (!r.ok) return needUi(r);
      const { percent: now, from } = r.result;
      const moved = from === undefined || from !== now;
      return ok({
        zoom: `${now}%`,
        ...(from !== undefined ? { from: `${from}%` } : {}),
        ...(steps > 1 && (action === 'in' || action === 'out') ? { steps } : {}),
        ...(moved ? {} : {
          note: action === 'in' ? `already at the maximum zoom (${now}%)`
            : action === 'out' ? `already at the minimum zoom (${now}%)`
            : `already at ${now}%`,
        }),
      });
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
    name: 'get_viewport_info',
    title: 'Viewport info',
    description:
      'The viewport in one call: `colorMode` (light, dark or auto = follows the device), the active viewport '
      + 'profile with its zoom, margins and light/dark theme ids, and the names of all profiles to pass to '
      + 'set_viewport. Profiles are stored in the browser that has the shell open, so without one `profiles` is '
      + 'null and only the color mode is known.',
    schema: z.object({}),
    annotations: READ,
    run: async () => {
      const [theme, r] = await Promise.all([getTheme(), ui<ViewportInfo>('getViewportInfo')]);
      const colorMode = theme.colorMode ?? 'dark';
      if (!r.ok) {
        return ok({ summary: `Color mode is ${colorMode}. Viewport profiles unknown: ${r.message}.`, colorMode, active: null, profiles: null });
      }
      const { active, profiles } = r.result;
      return ok({
        summary: `Viewport profile "${active.name}" at ${active.zoomPercent}% zoom, color mode ${colorMode}. `
          + `${profiles.length} profile${profiles.length === 1 ? '' : 's'}: ${profiles.map((p) => p.name).join(', ')}.`,
        colorMode,
        active: {
          name: active.name,
          zoom: `${active.zoomPercent}%`, shellZoom: `${active.shellZoomPercent}%`, appZoom: `${active.appZoomPercent}%`,
          margins: active.margins,
          themeLight: active.themeIdLight, themeDark: active.themeIdDark,
        },
        profiles: profiles.map((p) => p.name),
      });
    },
  }),

  define({
    name: 'set_viewport',
    title: 'Switch viewport profile',
    description:
      'Switch to a saved viewport profile by name — "set viewport default", "set viewport hello world". The '
      + 'profile brings its zoom, margins and themes along. A unique start of the name is enough; when several '
      + 'match, the result lists them. Profiles are stored in the browser that has the shell open, so this needs '
      + 'the shell open in a browser.',
    schema: z.object({ viewport: z.string().min(1).describe('The profile name, as listed by get_viewport_info.') }),
    annotations: WRITE,
    run: async ({ viewport }) => {
      const info = await ui<ViewportInfo>('getViewportInfo');
      if (!info.ok) return needUi(info);
      const m = resolveViewport(info.result.profiles, viewport);
      const bad = unresolved(m, 'viewport profiles', 'give the full name', (p: ViewportProfileSummary) => p.name);
      if (bad) return bad;
      const target = (m as { value: ViewportProfileSummary }).value;
      const r = await ui<{ from: ViewportProfileSummary | null; to: ViewportProfileSummary }>('setViewport', { id: target.id });
      if (!r.ok) return needUi(r);
      const { from, to } = r.result;
      return ok({
        viewport: to.name,
        ...(from ? { from: from.name } : {}),
        ...(from?.id === to.id ? { note: `"${to.name}" was already the active viewport` } : {}),
      });
    },
  }),

  colorModeTool('light'),
  colorModeTool('dark'),

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
      + 'TERM, OFF, ERR), pid, port, whether it is an app or a service, how many sidecars (runtimes such as a database '
      + 'or headless browser the app runs next to itself) it has, and its open windows (activities).',
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

  ...NOTIFICATION_TOOLS,
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** `x-aura-agent`, else the `user-agent` of the MCP client. Display only. */
export function agentFromHeaders(headers: Record<string, string | string[] | undefined> | undefined): string | undefined {
  if (!headers) return undefined;
  const pick = (k: string) => {
    const v = headers[k] ?? headers[k.toLowerCase()];
    const s = Array.isArray(v) ? v[0] : v;
    return typeof s === 'string' && s.trim() ? s.trim().slice(0, 100) : undefined;
  };
  return pick('x-aura-agent') ?? pick('user-agent');
}

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

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const tool = BY_NAME.get(req.params.name);
    if (!tool) return fail(`Unknown tool "${req.params.name}".`);
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const ctx: CallCtx = { ...(agentFromHeaders(extra?.requestInfo?.headers) ? { agentHeader: agentFromHeaders(extra?.requestInfo?.headers) } : {}) };
    if (tool.guard === false) {
      try { return await tool.run(args, ctx); }
      catch (err) { return fail(`${tool.name} failed: ${(err as Error).message}`); }
    }
    // Reading the same thing again and again, with nothing changed in
    // between, is a loop the answers themselves cannot break — so stop
    // answering with data and say so. A mutating call clears the count.
    const readOnly = tool.annotations.readOnlyHint === true;
    if (readOnly) {
      const { count, tripped } = recordRead(tool.name);
      if (tripped) {
        const msg = stopMessage(tool.name, count, Math.round(LOOP_WINDOW_MS / 1000));
        console.warn(`[mcp] loop brake: ${tool.name} ×${count}`);
        return { content: [{ type: 'text', text: msg }] };
      }
    } else {
      noteMutation();
    }

    // Absorption is for QUESTIONS only. Repeating a question gets the same
    // answer, so serving it from the last one is honest. Repeating a COMMAND
    // is not the same: `zoom set 150` then `zoom reset` then `zoom reset`
    // would hand back the first reset's answer and never zoom — the shell
    // stayed at 150 % while the result said 100 %. Commands always run.
    const exec = () => Promise.resolve(tool.run(args, ctx));
    const { duplicate, result } = readOnly ? dedupe(tool.name, args, exec) : { duplicate: false, result: exec() };
    let out: CallToolResult;
    try { out = await result; }
    catch (err) { return fail(`${tool.name} failed: ${(err as Error).message}`); }
    // Keep the headline so the brake can repeat it instead of the payload:
    // the first line of the text, unless that is JSON (then `summary`, which
    // is what a JSON-bodied tool leads with).
    const head = out.content.find((c) => c.type === 'text');
    const first = head && typeof head.text === 'string' ? head.text.split('\n')[0] ?? '' : '';
    const summary = out.structuredContent?.['summary'];
    const headline = first && !first.startsWith('{') ? first : (typeof summary === 'string' ? summary : '');
    if (headline) rememberAnswer(tool.name, headline);
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
