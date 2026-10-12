/**
 * `aura-terminal` — every terminal session in the OS as one MCP server.
 *
 * An agent's hands and eyes on a shell: list the sessions on every terminal
 * instance, open or kill one, read a session's screen as a text grid (with
 * cursor and alternate-screen mode, plus scrollback on request), type text,
 * send keys. The screen comes from tmux, which already hosts every shell, so
 * a session with no window on it reads exactly like one a human is watching
 * — and when a human IS watching, they see the agent type.
 *
 * Sessions are addressed by `target` (targets.ts): the full id
 * `<instanceId>#a<n>`, a spoken alias ("16A1", "14 a3", "a1"), or nothing at
 * all for the default session. The old `session` field still works as an
 * alias — but agent frameworks mask arguments with that name as `***`, which
 * is why `target` exists. Whichever instance serves the request acts on its
 * own sessions directly and forwards the rest to the owning container
 * (session-router.ts), so the agent only ever connects once.
 *
 * Safety (screen-summary.ts): input that would end the shell (`exit`, Ctrl+D
 * at a prompt) or confirm a destructive menu option ("No, exit") is refused
 * with a `refused: true` result unless `force: true`; kill_session and
 * opening a new instance need explicit confirmation.
 *
 * Built on the low-level `Server` like the Notepad's MCP: tools are written
 * as Zod objects and converted once at module load, and every tool body is
 * caught so a missing session or a dead container comes back as an `isError`
 * result with `{ code, message, hint, candidates? }`, never as a transport failure.
 *
 * Registration: `app.manifest.json` declares this server under `provides`
 * (kind `mcp`, address `/mcp/terminal`); the OS materialises it as a live
 * address for every running instance. No runtime call needed.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  dialogGetFor, dialogOpFor, inputFor, invalidateListing, killFor, listAll, openOn, screenFor,
} from '../session-router.ts';
import { isLocal, parseSessionId, remoteJson } from '../session-router.ts';
import { styledLocal } from '../session-service.ts';
import { dimRuns, ghostText, markDim } from '../screen-styles.ts';
import { findOption, menuExcerpt, menuFromStyled, optionLabel, planMove } from '../menu-select.ts';
import type { Menu } from '../screen-summary.ts';
import type { Listing } from '../session-router.ts';
import { LIMITS, SessionError, localInstanceId } from '../session-service.ts';
import type { ScreenView, SessionView } from '../session-service.ts';
import { KEY_HELP, TmuxError, mapKey } from '../tmux-control.ts';
import { TargetError, aliasOf, canonicalId, isMaskedTarget, parseSpoken, resolveTarget, TERMINAL_APP_ID } from '../targets.ts';
import type { Candidate, Resolved } from '../targets.ts';
import { isShellCommand, summarizeScreen, summaryLine } from '../screen-summary.ts';
import type { InputStep, ScreenSummary } from '../screen-summary.ts';
import { ACT_DEFAULTS, act, refusalFor, waitMatcher } from './act.ts';
import type { ActDeps, ActOptions } from './act.ts';

/** `AURA_TERM_TYPE_REVIEW=1` restores the human review dialog as type_text's default and lists the dialog tools. */
const REVIEW_MODE = process.env['AURA_TERM_TYPE_REVIEW'] === '1';

const INSTRUCTIONS =
  'Live terminal sessions across every AuraOS terminal instance. Address a session with `target`: an alias like '
  + '"16a1" (instance 16, session a1), "a1", or the full id `com.aura.terminal-16#a1`. Omit `target` to use the default '
  + 'session (the one used last, else the one a human has open, else the only one); every result echoes `target_used`. '
  + 'get_status is the cheap check (program, state, menu with its selected option, input prompt, last lines); get_screen '
  + 'returns the full `rows × cols` grid (row 0 at the top, cursor 0-based). The `state` tells you which tool fits, for '
  + 'any program: shell_prompt → run_command; menu → select_option / select_menu_option; text_input (a free-text input '
  + 'line or a yes/no question, see `prompt`) → act {text, enter: true}; editor / pager / busy / anything else → act or '
  + 'send_keys (key names, or literal text items such as ":wq"). Before pressing Enter on a menu read `menu`: Enter '
  + 'confirms the `selected` option. Safety guards refuse (a `refused: true` result, not an error) '
  + 'exit/logout/Ctrl+D at a shell prompt and confirming destructive menu options such as "No, exit"; pass `force: true` '
  + 'only when the user explicitly asked for exactly that. Never open or kill sessions or instances unless the user '
  + 'explicitly asked: kill_session needs `confirm: true`; open_session reuses an idle shell, and `instance: "new"` needs '
  + '`confirm_new_instance: true`. Error code `instance-unavailable` means the instance is restarting — retry after a '
  + 'few seconds, never open a new one. `inUse: true` means a human sees every keystroke. `settled: false` means the '
  + 'screen was still changing at `timeout_ms`.'
  + (REVIEW_MODE
    ? ' type_text opens a review dialog by default (get_dialog / set_dialog_text / insert_dialog / copy_dialog / close_dialog); `direct: true` types immediately.'
    : ' type_text types immediately (never presses Enter); `review: true` opens the human review dialog instead.');

// ── Result helpers ──────────────────────────────────────────────────────────

/** Compact JSON text (pretty-printing doubled the tokens) plus the structured record. */
function ok(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

interface ErrorInfo { code: string; message: string; hint?: string; candidates?: string[]; retry_after_ms?: number }

const CODE_HINTS: Record<string, string> = {
  'no-such-session': 'The shell has exited or the id is stale. Call list_sessions (or omit target for the default). Do NOT open a new session unless the user asked.',
  'shell-exited': 'A fresh shell was started in the same session and nothing was sent. Read the screen, then retry if it still makes sense. Do NOT open a new session.',
  'bad-key': `Key names: ${KEY_HELP} Words are typed literally — a near-miss of a key name is rejected so a typo never becomes keystrokes.`,
  'tmux-disabled': 'This instance cannot read or type into sessions; use a session on another instance.',
  'bad-session-id': 'Pass target as an alias like "16a1" or the full id from list_sessions.',
  'bad-instance': 'Pass an instance id like com.aura.terminal-16 (or "16"); list_sessions shows them.',
};

/** Structured, actionable error: readable text for the model plus `{ error }` for programs. */
function failWith(info: ErrorInfo): CallToolResult {
  const e: ErrorInfo = { ...info, hint: info.hint ?? CODE_HINTS[info.code] };
  const lines = [`[${e.code}] ${e.message}`];
  if (e.hint) lines.push(`hint: ${e.hint}`);
  if (e.candidates?.length) lines.push(`candidates: ${e.candidates.join('; ')}`);
  if (e.retry_after_ms) lines.push(`retry_after_ms: ${e.retry_after_ms}`);
  return { isError: true, content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { error: e as unknown as Record<string, unknown> } };
}

function errorResult(err: unknown, tool: string): CallToolResult {
  if (err instanceof TargetError) return failWith({ code: err.code, message: err.message, hint: err.hint, candidates: err.candidates });
  if (err instanceof SessionError) {
    return failWith({ code: err.code, message: `${tool} failed: ${err.message}`, hint: err.hint, ...(err.retryAfterMs ? { retry_after_ms: err.retryAfterMs } : {}) });
  }
  if (err instanceof TmuxError) return failWith({ code: err.code, message: `${tool} failed: ${err.message}` });
  return failWith({ code: 'internal', message: `${tool} failed: ${err instanceof Error ? err.message : String(err)}` });
}

/** What every targeted result carries about the session it acted on. */
function targetInfo(r: Resolved): Record<string, unknown> {
  return { target_used: r.id, alias: aliasOf(r.id), ...(r.resolved_from ? { resolved_from: r.resolved_from } : {}), ...(r.how.startsWith('default') ? { default_reason: r.how } : {}) };
}

function summarize(view: ScreenView): ScreenSummary {
  return summarizeScreen({
    command: view.command, title: view.title, mode: view.mode, screen: view.screen, cursor: view.cursor,
    dead: view.dead, deadStatus: view.deadStatus,
  });
}

/** The grid with its escape sequences, from whichever instance owns the session; null when unavailable (TM-16/17). */
async function styledFor(id: string): Promise<string[] | null> {
  try {
    const { instanceId } = parseSessionId(id);
    if (isLocal(instanceId)) return await styledLocal(id);
    const res = await remoteJson<{ styled?: string[] }>(instanceId, `/api/sessions/screen?id=${encodeURIComponent(id)}&styled=1`);
    return Array.isArray(res.styled) ? res.styled : null;
  } catch { return null; }
}

/** TM-17: faint-text fields for a screen — `ghost_text` when found; with markDimRuns also `dim` runs and the marked grid. */
async function dimInfo(view: ScreenView, markDimRuns: boolean): Promise<{ extra: Record<string, unknown>; marked?: string[] }> {
  const styled = await styledFor(view.id);
  if (!styled) return { extra: markDimRuns ? { dim_unavailable: true } : {} };
  const ghost = ghostText(styled, view.cursor);
  const extra: Record<string, unknown> = ghost ? { ghost_text: ghost } : {};
  if (!markDimRuns) return { extra };
  extra['dim'] = dimRuns(styled);
  const marked = markDim(styled);
  while (marked.length < view.rows) marked.push('');
  return { extra, marked };
}

/** A screen as text an agent can read at a glance, plus the full record. */
function screenResult(view: ScreenView, r: Resolved, extra: Record<string, unknown> = {}, marked?: string[]): CallToolResult {
  const summary = summarize(view);
  const from = r.resolved_from ? ` from ${JSON.stringify(r.resolved_from)}` : r.how.startsWith('default') ? ` (${r.how})` : '';
  const header =
    `[${view.id}] alias=${aliasOf(view.id)}${from} ${view.mode} ${view.cols}x${view.rows} cursor=(${view.cursor.x},${view.cursor.y}) `
    + `command=${view.command} inUse=${view.inUse} settled=${view.settled}`
    + (view.elapsedMs !== undefined ? ` elapsed_ms=${view.elapsedMs}` : '')
    + (view.scrollback.length ? ` scrollback=${view.scrollback.length} lines` : '');
  const parts = [header, summaryLine(summary)];
  if (extra['warning']) parts.push(`warning: ${String(extra['warning'])}`);
  if (typeof extra['ghost_text'] === 'string') parts.push(`ghost_text: ${JSON.stringify(extra['ghost_text'])} (faint placeholder/suggestion on the input row, NOT typed input)`);
  if (view.scrollback.length) parts.push('--- scrollback ---', ...view.scrollback);
  parts.push(marked ? '--- screen (faint text as ⟦dim:…⟧) ---' : '--- screen ---', ...(marked ?? view.screen.map((l) => l.replace(/\s+$/, ''))));
  return {
    content: [{ type: 'text', text: parts.join('\n') }],
    structuredContent: { ...(view as unknown as Record<string, unknown>), summary, ...targetInfo(r), ...extra },
  };
}

function statusPayload(view: ScreenView, r: Resolved): Record<string, unknown> {
  const s = summarize(view);
  return {
    ...targetInfo(r), program: s.program, state: s.state, menu: s.menu, input: s.input,
    ...(s.prompt ? { prompt: s.prompt } : {}), last_lines: s.last_lines,
    ...(s.state === 'exited' ? { exit_status: s.exit_status ?? null } : {}),
    ...(view.respawned ? { respawned: true } : {}),
    command: view.command, mode: view.mode, cursor: view.cursor, inUse: view.inUse,
  };
}

// ── Targets ─────────────────────────────────────────────────────────────────

/** The session this process acted on last — the first choice for the default target. */
let lastTarget: string | null = null;

function candidatesFrom(listing: Listing): Candidate[] {
  return listing.instances.flatMap((i) => i.sessions.map((s) => ({ id: s.id, inUse: s.inUse, command: s.command })));
}

interface TargetArgs { target?: string; session?: string }

/** `target`, else the deprecated `session`; a masked value counts as not given. */
function rawTarget(a: TargetArgs): string | undefined {
  if (!isMaskedTarget(a.target)) return a.target;
  if (!isMaskedTarget(a.session)) return a.session;
  return a.target ?? a.session;
}

async function resolve(a: TargetArgs): Promise<Resolved> {
  const raw = rawTarget(a);
  if (raw !== undefined && !isMaskedTarget(raw)) {
    const canon = canonicalId(raw);
    if (canon) return { id: canon, resolved_from: canon === raw.trim() ? null : raw, how: 'exact' };
  }
  return resolveTarget(raw, candidatesFrom(await listAll()), { last: lastTarget });
}

function touch(id: string): void { lastTarget = id; }

// ── Input ───────────────────────────────────────────────────────────────────

const KEY_WORDS = ['enter', 'return', 'tab', 'escape', 'esc', 'backspace', 'delete', 'insert', 'space', 'up', 'down',
  'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'pgup', 'pgdn', 'btab', ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)];

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length]![b.length]!;
}

/** A string that is almost a key name ("Enterr", "Ctrl+é", "Super+x") — rejected rather than typed. */
export function looksLikeKeyTypo(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (/^(ctrl|control|alt|meta|shift|opt|option|cmd|super|win|c|m|s)[+-]./.test(t)) return true;
  if (!/^[a-z]+\d*$/.test(t)) return false;
  return KEY_WORDS.some((k) => editDistance(t, k) <= (k.length <= 4 ? 1 : 2));
}

/** send_keys items → ordered steps: key names stay keys, other strings are literal text (B12). */
export function keysToSteps(keys: string[]): InputStep[] {
  return keys.map((k) => {
    try { mapKey(k); return { key: k }; }
    catch (err) {
      if (!(err instanceof TmuxError) || [...k].length <= 1 || looksLikeKeyTypo(k)) throw err;
      return { text: k };
    }
  });
}

/** Steps → as few input calls as possible (each call sends its text, then its keys). */
async function sendSteps(id: string, steps: InputStep[], paste = false): Promise<{ chars: number; keys: string[] }> {
  let text = '';
  let keys: string[] = [];
  const sent = { chars: 0, keys: [] as string[] };
  const flush = async () => {
    if (!text && !keys.length) return;
    const r = await inputFor(id, { ...(text ? { text, paste } : {}), keys });
    sent.chars += r.sent.chars;
    sent.keys.push(...r.sent.keys);
    text = ''; keys = [];
  };
  for (const s of steps) {
    if ('text' in s) { if (keys.length) await flush(); text += s.text; }
    else keys.push(s.key);
  }
  await flush();
  return sent;
}

/** The B6 check: read the screen once, refuse input that ends the shell or confirms a destructive option. */
async function guarded(r: Resolved, steps: InputStep[], force: boolean | undefined, opts: { refuseOnMenu?: boolean } = {}):
  Promise<{ refused: CallToolResult } | { summary: ScreenSummary | null }> {
  if (force) return { summary: null };
  const view = await screenFor(r.id, { settleMs: 0 });
  const summary = summarize(view);
  const refusal = refusalFor(summary, steps, { ...opts, respawned: view.respawned });   // act.ts: the one B6 decision
  if (refusal) return { refused: ok({ ...refusal, ...targetInfo(r) }) };
  return { summary };
}

/** act (TM-11) wired to the live session router; `sendSteps` keeps the input to as few `inputFor` calls as possible. */
const ACT_DEPS: ActDeps = {
  screen: (id, opts) => screenFor(id, opts),
  send: (id, steps, paste) => sendSteps(id, steps, paste),
};

/** Resolve → act → the refusal (with target info) or the outcome. Touches the target only when input went out. */
async function actOn(r: Resolved, opts: ActOptions) {
  const out = await act(ACT_DEPS, r.id, opts);
  if ('refused' in out) return { refused: ok({ ...out.refused, ...targetInfo(r) }) };
  touch(r.id);
  return { out };
}

// ── Menu selection (TM-16) ──────────────────────────────────────────────────

/** TM-16/17 addendum to the server instructions (kept separate from INSTRUCTIONS). */
const MENU_INSTRUCTIONS =
  ' To pick an option in a TUI menu use select_menu_option (one call: moves, verifies, presses Enter only with '
  + '`submit: true`). `ghost_text` / ⟦dim:…⟧ text (get_screen `mark_dim: true`) is a faint suggestion, not typed input.';

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

type MenuSource = 'marker' | 'reverse-video' | 'typed';

/** The menu on screen: summary.menu (a selection glyph, or a typed-number list), else a reverse-video highlighted row. */
async function readMenu(id: string, settleMs: number): Promise<{ view: ScreenView; summary: ScreenSummary; menu: Menu | null; by: MenuSource | null }> {
  const view = await screenFor(id, { settleMs, timeoutMs: 2_000 });
  const summary = summarize(view);
  if (summary.menu) return { view, summary, menu: summary.menu, by: summary.menu.selection === 'typed' ? 'typed' : 'marker' };
  if (summary.state === 'exited' || summary.state === 'shell_prompt') return { view, summary, menu: null, by: null };
  const styled = await styledFor(id);
  const menu = styled ? menuFromStyled(styled, view.cursor.y) : null;
  return { view, summary, menu, by: menu ? 'reverse-video' : null };
}

const tailOf = (screen: string[], n = 12) => screen.map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim()).slice(-n);
const selectedLabel = (m: Menu | null) => (m ? m.options[m.selected_index]?.label ?? null : null);

interface SelectArgs extends TargetArgs {
  option: number | string; submit?: boolean; confirm?: boolean; text?: string;
  mode?: 'fast' | 'step'; prefer_digit?: boolean; delay_ms?: number; force?: boolean;
}

async function selectMenuOption(a: SelectArgs): Promise<CallToolResult> {
  const r = await resolve(a);
  const submit = a.submit === true || a.confirm === true;
  const step = a.mode === 'step';
  const delay = a.delay_ms ?? 50;
  const first = await readMenu(r.id, 0);
  if (!first.menu) {
    return failWith({
      code: 'no-menu', message: `No selection menu on screen (program=${first.summary.program}, state=${first.summary.state}).`,
      hint: 'Nothing was sent. Read get_screen; a text prompt takes type_text, a shell takes run_command.', candidates: first.summary.last_lines,
    });
  }
  const found = findOption(first.menu, a.option);
  if ('error' in found) {
    return failWith({ code: found.error.code, message: found.error.message, hint: 'Nothing was sent. Pick one of the candidates, or ask the user which one.', candidates: found.error.candidates });
  }
  const target = found.option;
  if (submit && target.destructive && a.force !== true) {
    return ok({
      refused: true, reason: `Submitting "${optionLabel(target)}" is destructive${first.menu.question ? ` for "${first.menu.question}"` : ''}.`,
      would_select: optionLabel(target), hint: 'Nothing was sent. Pass force:true only if the user explicitly asked for exactly this option; submit:false only moves there.',
      ...targetInfo(r),
    });
  }
  touch(r.id);
  const base = { selected: target.label, number: target.number, index: target.index + 1, ...(target.destructive ? { destructive: true } : {}) };

  // A menu without a highlight: type the option's number (Enter only with submit). Typing alone confirms nothing.
  if (first.menu.selection === 'typed') {
    if (a.text) {
      return failWith({ code: 'bad-arguments', message: 'This menu is answered by typing a number; it has no free-text row for `text`.', hint: 'Nothing was sent. Pick the option alone, or use act for free text.' });
    }
    const digits = String(target.number ?? target.index + 1);
    const steps: InputStep[] = [{ text: digits }, ...(submit ? [{ key: 'Enter' }] : [])];
    const g = await guarded(r, steps, a.force || !submit);
    if ('refused' in g) return g.refused;
    await sendSteps(r.id, steps);
    const after = await screenFor(r.id, { settleMs: submit ? 250 : 150, timeoutMs: 3_000 });
    return ok({ ...base, method: 'typed', detected_by: 'typed', typed: digits, submitted: submit, screen_tail: tailOf(after.screen), ...targetInfo(r) });
  }

  // On a highlight menu with numbers a digit usually selects AND confirms at once, so it is only used with submit.
  const numbered = first.menu.options.some((o) => o.number !== null);
  if (a.prefer_digit && submit && !a.text && numbered && target.number !== null && target.number <= 9) {
    const steps: InputStep[] = [{ key: String(target.number) }];
    const g = await guarded(r, steps, a.force);
    if ('refused' in g) return g.refused;
    await sendSteps(r.id, steps);
    const after = await screenFor(r.id, { settleMs: 250, timeoutMs: 3_000 });
    return ok({ ...base, method: 'digit', detected_by: first.by, submitted: true, screen_tail: tailOf(after.screen), ...targetInfo(r) });
  }

  let menu: Menu | null = first.menu;
  let by = first.by;
  let last = first.view;
  let moved: { key: 'Up' | 'Down' | null; count: number } = { key: null, count: 0 };
  let presses = 0;
  const steps: Array<{ pressed: string; selected: string | null; menu_lines: string[] }> = [];
  for (let attempt = 0; attempt < 3 && menu && selectedLabel(menu) !== target.label; attempt++) {
    const idx = menu.options.findIndex((o) => o.label === target.label);
    if (idx < 0) break;   // the menu changed under us; verification below reports it
    const plan = planMove(menu, idx);
    if (!plan.key) break;
    if (attempt === 0) moved = plan;
    for (let i = 0; i < plan.count; i++) {
      if (i > 0 && !step && delay > 0) await sleep(delay);
      await sendSteps(r.id, [{ key: plan.key }]);
      presses++;
      if (step) {
        const rd = await readMenu(r.id, 120);
        ({ view: last, menu } = rd);
        by = rd.by ?? by;
        steps.push({ pressed: plan.key, selected: selectedLabel(menu), menu_lines: menuExcerpt(rd.view.screen, menu) });
        if (!menu) break;
      }
    }
    if (!step) {
      const rd = await readMenu(r.id, 150);
      ({ view: last, menu } = rd);
      by = rd.by ?? by;
    }
  }
  if (selectedLabel(menu) !== target.label) {
    return failWith({
      code: 'not-verified',
      message: `After ${presses} key press(es) the selection is on ${JSON.stringify(selectedLabel(menu))}, not "${optionLabel(target)}".`,
      hint: 'Nothing was submitted. Read get_screen before trying again.', candidates: tailOf(last.screen),
    });
  }

  let typed: string | undefined;
  if (a.text) {
    const g = await guarded(r, [{ text: a.text }], a.force);
    if ('refused' in g) return g.refused;
    await sendSteps(r.id, [{ text: a.text }]);
    typed = a.text;
  }
  let submitted = false;
  if (submit) {
    const g = await guarded(r, [{ key: 'Enter' }], a.force);
    if ('refused' in g) return g.refused;
    await sendSteps(r.id, [{ key: 'Enter' }]);
    submitted = true;
    last = await screenFor(r.id, { settleMs: 250, timeoutMs: 3_000 });
  } else if (typed) {
    last = await screenFor(r.id, { settleMs: 150, timeoutMs: 2_000 });
  }
  return ok({
    ...base, method: 'arrows', mode: step ? 'step' : 'fast', detected_by: by, moved, presses, verified: true, submitted,
    ...(typed !== undefined ? { typed } : {}),
    ...(step ? { steps } : {}),
    screen_tail: submitted || typed ? tailOf(last.screen) : menuExcerpt(last.screen, menu),
    ...targetInfo(r),
  });
}

// ── Tool definitions ────────────────────────────────────────────────────────

interface OwnTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  annotations: ToolAnnotations;
  run: (raw: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
}

function define<S extends z.ZodObject<z.ZodRawShape>>(opts: {
  name: string;
  title: string;
  description: string;
  schema: S;
  annotations: ToolAnnotations;
  run: (args: z.infer<S>) => CallToolResult | Promise<CallToolResult>;
}): OwnTool {
  const { $schema: _drop, ...json } = zodToJsonSchema(opts.schema, { $refStrategy: 'none' }) as Record<string, unknown>;
  return {
    name: opts.name,
    title: opts.title,
    description: opts.description,
    inputSchema: json as Tool['inputSchema'],
    annotations: opts.annotations,
    run: (raw) => {
      const parsed = opts.schema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        return failWith({ code: 'bad-arguments', message: `Invalid arguments for ${opts.name}: ${issues}`, hint: 'Check the tool schema.' });
      }
      return opts.run(parsed.data);
    },
  };
}

const READ:  ToolAnnotations = { readOnlyHint: true, idempotentHint: true };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };
const KILL:  ToolAnnotations = { readOnlyHint: false, destructiveHint: true };
const SPAWN: ToolAnnotations = { readOnlyHint: false, destructiveHint: true };

const TARGET = z.string().optional()
  .describe('Session: alias like "16a1" (instance 16, session a1), "a1", or the full id. Omit for the default session.');
const SESSION_ALIAS = z.string().optional().describe('Deprecated alias of `target`.');
const FORCE = z.boolean().optional().describe('Bypass the safety guard. Only when the user explicitly asked for exactly this.');
const SETTLE  = z.number().int().min(0).max(LIMITS.settleMs)
  .describe('Return once the screen has been unchanged for this many ms (0 = read once, immediately).');
const TIMEOUT = z.number().int().min(100).max(LIMITS.timeoutMs)
  .describe('Give up waiting for the screen to settle after this many ms and return the latest frame.');
const SCROLL  = z.number().int().min(0).max(LIMITS.scrollback)
  .describe('Also return up to this many lines of scrollback from above the visible grid.');

function compactRow(s: SessionView): Record<string, unknown> {
  const cmd = s.command ?? null;
  return {
    id: s.id, alias: aliasOf(s.id), live: s.live, inUse: s.inUse,
    program: cmd === null ? null : isShellCommand(cmd) ? 'shell' : cmd,
    state: cmd === null ? 'unknown' : s.alternate ? 'fullscreen' : isShellCommand(cmd) ? 'shell_prompt' : 'busy',
  };
}

function normalizeInstance(v: string): string {
  if (v === 'new') return v;
  const t = v.trim();
  if (/^com\.aura\.terminal(-\d+)?$/i.test(t)) return t.toLowerCase();
  const sp = parseSpoken(t);
  if (sp && sp.instance && !sp.label) return `${TERMINAL_APP_ID}-${sp.instance}`;
  return t;
}

const TARGETED = { target: TARGET, session: SESSION_ALIAS };

const DIALOG_TOOLS: OwnTool[] = [
  define({
    name: 'get_dialog',
    title: 'Read the review dialog',
    description:
      'The session\'s review dialog (opened by type_text): its current text — including edits the human made — '
      + 'its status ("open", "inserted", "copied", "closed") and `by`, who made the last change ("agent" or "user"). '
      + '`dialog: null` means none was ever opened.',
    schema: z.object(TARGETED),
    annotations: READ,
    run: async (a) => { const r = await resolve(a); return ok({ ...await dialogGetFor(r.id) as unknown as Record<string, unknown>, ...targetInfo(r) }); },
  }),
  define({
    name: 'set_dialog_text',
    title: 'Edit the review dialog',
    description: 'Replace the text in the session\'s open review dialog. The human sees the change live.',
    schema: z.object({ ...TARGETED, text: z.string().max(65_536).describe('The new text.') }),
    annotations: WRITE,
    run: async (a) => { const r = await resolve(a); return ok({ ...await dialogOpFor(r.id, { op: 'set', text: a.text }) as unknown as Record<string, unknown>, ...targetInfo(r) }); },
  }),
  define({
    name: 'insert_dialog',
    title: 'Insert the dialog text',
    description: 'Click Insert on the open review dialog: its current text goes into the shell (no Enter) and the dialog closes.',
    schema: z.object(TARGETED),
    annotations: WRITE,
    run: async (a) => { const r = await resolve(a); touch(r.id); return ok({ ...await dialogOpFor(r.id, { op: 'insert' }) as unknown as Record<string, unknown>, ...targetInfo(r) }); },
  }),
  define({
    name: 'copy_dialog',
    title: 'Copy the dialog text',
    description:
      'Ask the terminal window to copy the open dialog\'s text to the clipboard. Browsers usually only allow the '
      + 'clipboard on a human click, so this may not succeed on its own: the dialog stays open, the result has '
      + '`copyRequested: true`, and the window prompts the human to click Copy. Check get_dialog for status "copied".',
    schema: z.object(TARGETED),
    annotations: WRITE,
    run: async (a) => { const r = await resolve(a); return ok({ ...await dialogOpFor(r.id, { op: 'copy' }) as unknown as Record<string, unknown>, ...targetInfo(r) }); },
  }),
  define({
    name: 'close_dialog',
    title: 'Close the review dialog',
    description: 'Dismiss the open review dialog without inserting anything.',
    schema: z.object(TARGETED),
    annotations: WRITE,
    run: async (a) => { const r = await resolve(a); return ok({ ...await dialogOpFor(r.id, { op: 'close' }) as unknown as Record<string, unknown>, ...targetInfo(r) }); },
  }),
];

const TOOLS: OwnTool[] = [
  define({
    name: 'list_sessions',
    title: 'List terminal sessions',
    description:
      'Every terminal session on every terminal instance, grouped by instance — call it to find a `target` when the '
      + 'user names a session you do not know, or to see what runs where. Returns per session `id`, short `alias` ("16a1"), `inUse` '
      + '(a human window renders it), `program` and `state`. `default_target` is the session used when you omit target. '
      + 'An instance that is not serving or did not answer is listed with `reachable: false` and why (`stale: true`: '
      + 'its last known sessions). Paused instances are not queried unless `include_paused: true` (that wakes them). '
      + '`verbose: true` adds pane size, title and the raw foreground command. Example: {} → then get_status {target: "16a1"}.',
    schema: z.object({
      verbose: z.boolean().optional().describe('Full rows instead of the compact view.'),
      include_paused: z.boolean().optional().describe('Also query paused instances (resumes them; slower).'),
    }),
    annotations: READ,
    run: async ({ verbose, include_paused }) => {
      const listing = await listAll({ includePaused: include_paused === true });
      let default_target: string | null = null;
      try { default_target = resolveTarget(undefined, candidatesFrom(listing), { last: lastTarget }).id; } catch { /* none */ }
      return ok({
        instances: listing.instances.map((i) => ({ ...i, sessions: verbose ? i.sessions : i.sessions.map(compactRow) })),
        default_target,
        ...(listing.degraded ? { degraded: true, degradedReason: listing.degradedReason } : {}),
      });
    },
  }),

  define({
    name: 'get_status',
    title: 'Session status',
    description:
      'Cheap check of one session without the screen grid — call it first to decide what to do next. Returns '
      + '`program` ("shell", the foreground command such as "vim" or "python", or a known TUI\'s label), `state` '
      + '(shell_prompt, busy, menu, text_input, pager, editor, exited), `menu` (question, options with `selected` and '
      + '`destructive`; `selection: "typed"` = answer by typing the number), `prompt` on text_input (kind "line" or '
      + '"yes_no" with its `question`, `default` and `destructive`), the typed-but-unsent `input` at a shell prompt, '
      + 'and the last 3 non-empty rows. Example: {target: "a1"} → state "menu" → select_option; state "text_input" '
      + 'with prompt.kind "yes_no" → act {text: "y", enter: true} only if the user wants yes.',
    schema: z.object(TARGETED),
    annotations: READ,
    run: async (a) => {
      const r = await resolve(a);
      const view = await screenFor(r.id, { settleMs: 0 });
      const payload = statusPayload(view, r);
      if (payload['state'] === 'text_input') Object.assign(payload, (await dimInfo(view, false)).extra);
      return ok(payload);
    },
  }),

  define({
    name: 'open_session',
    title: 'Open a session',
    description:
      'Only when the user explicitly asked for a new terminal session; to work in an existing one just pass its '
      + '`target` to the other tools. Example: {} (an idle shell on this instance). Reuses an idle shell (no human window, nothing '
      + 'running) on the instance unless `reuse: false`. `instance`: omit for the instance serving this call, or an '
      + 'instance id / number. `instance: "new"` starts another terminal container and needs `confirm_new_instance: true`.',
    schema: z.object({
      instance: z.string().min(1).optional().describe('Instance id (`com.aura.terminal-<n>`) or number, or "new".'),
      reuse: z.boolean().optional().describe('Return an idle existing shell instead of creating one (default true).'),
      confirm_new_instance: z.boolean().optional().describe('Required with instance:"new" — only when the user asked for a new terminal instance.'),
      cols: z.number().int().min(LIMITS.cols.min).max(LIMITS.cols.max).optional().describe('Initial width, default 80.'),
      rows: z.number().int().min(LIMITS.rows.min).max(LIMITS.rows.max).optional().describe('Initial height, default 24.'),
    }),
    annotations: SPAWN,
    run: async ({ instance, reuse, confirm_new_instance, cols, rows }) => {
      const inst = instance === undefined ? undefined : normalizeInstance(instance);
      if (inst === 'new' && confirm_new_instance !== true) {
        return ok({
          refused: true,
          reason: 'instance:"new" starts a whole new terminal container.',
          hint: 'Not done. Use an existing session (list_sessions). Pass confirm_new_instance:true only if the user explicitly asked for a new terminal instance.',
        });
      }
      if (inst !== 'new') {
        const listing = await listAll({ includePaused: true });
        const instanceId = inst ?? localInstanceId();
        const row = listing.instances.find((i) => i.instanceId === instanceId);
        if (inst !== undefined && !row && !listing.degraded) {
          return failWith({
            code: 'instance-not-running', message: `${instanceId} is not a running terminal instance.`,
            hint: 'Pick one of the candidates. Do not start a new instance unless the user asked.',
            candidates: listing.instances.map((i) => `${i.instanceId} (${i.state})`),
          });
        }
        if (row && !row.reachable && !row.stale) {
          return failWith({
            code: 'instance-unavailable', message: `${instanceId} is ${row.state}: ${row.error ?? 'not reachable'}`,
            hint: 'Retry in a few seconds. Do NOT open a new instance.', retry_after_ms: 3_000,
          });
        }
        if (reuse !== false && row) {
          const idle = row.sessions.find((s) => !s.inUse && isShellCommand(s.command) && s.alternate !== true);
          if (idle) {
            touch(idle.id);
            return ok({
              instanceId, session: idle, reused: true, target_used: idle.id, alias: aliasOf(idle.id),
              hint: 'An idle existing shell was reused; pass reuse:false for a brand-new one.',
            });
          }
        }
      }
      const res = await openOn(inst, { cols, rows });
      invalidateListing();
      touch(res.session.id);
      return ok({ ...res, reused: false, target_used: res.session.id, alias: aliasOf(res.session.id) });
    },
  }),

  define({
    name: 'kill_session',
    title: 'Kill a session',
    description:
      'End a shell for good: kills the tmux session, everything running in it and its scrollback; a human\'s window '
      + 'on it goes dark. Only when the user explicitly asked to close/kill this session: requires `confirm: true`, '
      + 'and a session a human has open also needs `force: true`. To stop a program use send_keys ["Ctrl+C"]. '
      + 'Example: {target: "16a2", confirm: true}.',
    schema: z.object({
      ...TARGETED,
      confirm: z.boolean().optional().describe('Must be true — the user explicitly asked to kill this session.'),
      force: z.boolean().optional().describe('Also kill a session a human has open in a window.'),
    }),
    annotations: KILL,
    run: async (a) => {
      const r = await resolve(a);
      if (a.confirm !== true) {
        return ok({
          refused: true, ...targetInfo(r),
          reason: 'kill_session ends the shell and everything running in it.',
          hint: 'Not done. Pass confirm:true only if the user explicitly asked to close/kill this session; to stop a program send Ctrl+C.',
        });
      }
      if (a.force !== true) {
        const listing = await listAll({ includePaused: true });
        const row = listing.instances.flatMap((i) => i.sessions).find((s) => s.id === r.id);
        if (row?.inUse) {
          return ok({
            refused: true, ...targetInfo(r),
            reason: 'A human has this session open in a window.',
            hint: 'Not done. Pass force:true only if the user explicitly asked to kill this open session.',
          });
        }
      }
      const res = await killFor(r.id);
      invalidateListing();
      if (lastTarget === r.id) lastTarget = null;
      return ok({ ...res, ...targetInfo(r) });
    },
  }),

  define({
    name: 'get_screen',
    title: 'Read the screen',
    description:
      'The session\'s screen as the human sees it — use it when get_status is not enough (reading output, an editor, '
      + 'an unrecognised layout): a `rows × cols` grid, cursor, `mode` ("alternate" when a full-screen program owns it), '
      + 'the foreground command, a `summary` (program, state, menu, prompt), and optionally `scrollback_lines`. '
      + 'Waits until the screen is still for `settle_ms` (default 200; spinners and timers are ignored). '
      + '`summary_only: true` = get_status. `mark_dim: true` wraps faint (dim or grey) text in the screen text as ⟦dim:…⟧ and '
      + 'adds `dim` runs; `ghost_text` (also reported on input prompts without it) is a faint placeholder or suggestion '
      + 'on the cursor row — it is NOT typed input, typing replaces it. Examples: {target: "a1"}; '
      + '{target: "a1", scrollback_lines: 200} for output that scrolled away; {mark_dim: true} when unsure what is typed.',
    schema: z.object({
      ...TARGETED,
      scrollback_lines: SCROLL.optional(),
      settle_ms: SETTLE.optional(),
      timeout_ms: TIMEOUT.optional(),
      summary_only: z.boolean().optional().describe('Return only the summary, no grid.'),
      mark_dim: z.boolean().optional().describe('Mark faint text (SGR dim or grey foreground) as ⟦dim:…⟧ in the screen text and list it in `dim` (ghost suggestions, hints).'),
    }),
    annotations: READ,
    run: async (a) => {
      const r = await resolve(a);
      if (a.summary_only) return ok(statusPayload(await screenFor(r.id, { settleMs: a.settle_ms ?? 0, timeoutMs: a.timeout_ms }), r));
      const view = await screenFor(r.id, { scrollback: a.scrollback_lines, settleMs: a.settle_ms, timeoutMs: a.timeout_ms });
      if (!a.mark_dim && summarize(view).state !== 'text_input') return screenResult(view, r);
      const dim = await dimInfo(view, a.mark_dim === true);
      return screenResult(view, r, dim.extra, dim.marked);
    },
  }),

  define({
    name: 'type_text',
    title: 'Type text',
    description: REVIEW_MODE
      ? 'Offer text for the session in a review dialog (Insert / Copy buttons for the human; follow up with get_dialog). '
        + '`direct: true` types right away instead. Never presses Enter. `paste: true` = bracketed paste (multi-line text).'
      : 'Type text into the session right away, character for character, without pressing Enter — for filling an input '
        + 'line the human (or a later send_keys ["Enter"]) submits. To type AND submit AND see the result use act '
        + '{text, enter: true}; at a shell use run_command. `paste: true` = bracketed paste, for multi-line text. '
        + '`review: true` opens a review dialog for the human instead. Example: {target: "a1", text: "git status"}.',
    schema: z.object({
      ...TARGETED,
      text: z.string().min(1).max(65_536).describe('The characters to type.'),
      paste: z.boolean().optional().describe('Deliver as a bracketed paste instead of keystrokes.'),
      direct: z.boolean().optional().describe('Type immediately (the default unless review mode is on).'),
      review: z.boolean().optional().describe('Open the human review dialog instead of typing.'),
      force: FORCE,
    }),
    annotations: WRITE,
    run: async (a) => {
      const r = await resolve(a);
      const review = a.review === true || (REVIEW_MODE ? a.direct !== true : a.direct === false);
      if (review) return ok({ ...await dialogOpFor(r.id, { op: 'open', text: a.text, paste: a.paste }) as unknown as Record<string, unknown>, ...targetInfo(r) });
      const steps: InputStep[] = [{ text: a.text }];
      const g = await guarded(r, steps, a.force);
      if ('refused' in g) return g.refused;
      const sent = await sendSteps(r.id, steps, a.paste ?? false);
      touch(r.id);
      return ok({ id: r.id, sent, ...targetInfo(r) });
    },
  }),

  define({
    name: 'send_keys',
    title: 'Send keys',
    description:
      'Press keys in the session, in order — for full-screen programs, control keys and raw navigation (to pick a menu '
      + 'option prefer select_option; to also see the result prefer act). Items that are not key '
      + `names are typed literally (e.g. ["Escape", ":wq", "Enter"]). Key names: ${KEY_HELP} A near-miss of a key name `
      + '("Enterr") is rejected before anything is sent. Guarded: exit/Ctrl+D at a shell prompt and Enter on a destructive '
      + 'menu option are refused unless force. `times` repeats the whole `keys` sequence (e.g. ["Down"] times 5, '
      + '["Ctrl+C"] times 3) with `delay` ms between repeats; the guard re-checks the screen before every repeat.',
    schema: z.object({
      ...TARGETED,
      keys: z.array(z.string().min(1)).min(1).max(64).describe('Key names and/or literal text, e.g. ["Ctrl+C"], ["Up", "Enter"], ["Escape", ":wq", "Enter"].'),
      times: z.number().int().min(1).max(LIMITS.keyRepeats).optional().describe('How often to send the whole `keys` sequence (default 1).'),
      delay: z.number().int().min(0).max(LIMITS.keyRepeatDelayMs).optional().describe('Milliseconds to wait between repeats (default 50). Ignored when times is 1.'),
      force: FORCE,
    }),
    annotations: WRITE,
    run: async (a) => {
      const steps = keysToSteps(a.keys);
      const r = await resolve(a);
      const times = a.times ?? 1;
      const delay = a.delay ?? 50;
      const sent = { chars: 0, keys: [] as string[] };
      for (let i = 0; i < times; i++) {
        if (i > 0 && delay > 0) await new Promise((res) => setTimeout(res, delay));
        // Re-check every repeat: the first Ctrl+D may end a program, the next one would end the shell.
        const g = await guarded(r, steps, a.force);
        if ('refused' in g) {
          if (i === 0) return g.refused;
          touch(r.id);
          return ok({ id: r.id, sent, times_sent: i, stopped: g.refused.structuredContent, ...targetInfo(r) });
        }
        const s = await sendSteps(r.id, steps);
        sent.chars += s.chars;
        sent.keys.push(...s.keys);
      }
      touch(r.id);
      return ok({ id: r.id, sent, ...(times > 1 ? { times_sent: times } : {}), ...targetInfo(r) });
    },
  }),

  define({
    name: 'select_menu_option',
    title: 'Pick a menu option',
    description:
      'Move the selection of the menu on screen to one option in ONE call — use it when state is "menu" and you want '
      + 'to highlight (or highlight + type into) an option without necessarily confirming it. Works on any TUI list: a '
      + 'selection glyph (❯ › → ▶ ● ➤, or an fzf-style ">"), a reverse-video row, or a numbered list answered by typing '
      + 'the number (`menu.selection: "typed"`: types the number; Enter only with submit). Reads the menu, sends exactly '
      + 'the Up/Down presses needed, re-reads and verifies the selection is on the target, and returns the menu excerpt. `option`: the number shown on a numbered menu, else its 1-based '
      + 'row, or its label (exact, prefix or unique substring). Never presses Enter unless `submit: true` (alias `confirm`); '
      + 'submitting a destructive option ("No, exit") is refused unless force. `text` types into a free-text row after moving. '
      + '`mode: "step"` moves one row at a time with a screen check after each (use it next to destructive options). '
      + '`prefer_digit: true` with submit presses that digit instead. An unknown or ambiguous label fails with the options. '
      + 'Examples: {option: "Settings"}; {option: 3, mode: "step"}; {option: "Type something", text: "my answer", submit: true}.',
    schema: z.object({
      ...TARGETED,
      option: z.union([z.number().int().min(1).max(99), z.string().min(1).max(200)])
        .describe('Option number (numbered menus) or 1-based row, or the label / a unique part of it, e.g. 2 or "Console".'),
      submit: z.boolean().optional().describe('Press Enter after the selection is verified (default false).'),
      confirm: z.boolean().optional().describe('Alias of submit.'),
      text: z.string().min(1).max(4_096).optional().describe('Text to type after moving, for a free-text row ("Type something").'),
      mode: z.enum(['fast', 'step']).optional().describe('"fast" (default): all presses, then one check. "step": check after every press.'),
      prefer_digit: z.boolean().optional().describe('With submit on a numbered menu: press the digit (selects and confirms) instead of arrows.'),
      delay_ms: z.number().int().min(0).max(500).optional().describe('Pause between arrow presses in fast mode (default 50).'),
      force: FORCE,
    }),
    annotations: WRITE,
    run: (a) => selectMenuOption(a),
  }),

  define({
    name: 'select_option',
    title: 'Choose a menu option',
    description:
      'Choose one option of the selection menu on screen and confirm it, in one call — the usual tool when state is '
      + '"menu" (any TUI picker, numbered list or fzf-style list): select_menu_option with '
      + '`submit: true` (moves with Up/Down, verifies the highlight is on the option, only then presses Enter). '
      + '`option`: the number shown, else the 1-based row, or the label or a unique part of it. Examples: '
      + '{option: 2}, {option: "Yes"}, {option: "dark mode"}. Confirming a destructive option (labels like "No, exit", '
      + '"Delete", "Discard") is refused unless force. To only move the highlight without confirming, use select_menu_option.',
    schema: z.object({
      ...TARGETED,
      option: z.union([z.number().int().min(1).max(99), z.string().min(1).max(200)])
        .describe('Option number (numbered menus) or 1-based row, or the label / a unique part of it.'),
      force: FORCE,
    }),
    annotations: WRITE,
    // TM-11: a thin alias, so there is one menu picker (TM-16).
    run: (a) => selectMenuOption({ ...a, submit: true }),
  }),

  define({
    name: 'run_command',
    title: 'Run a shell command',
    description:
      'Type a command at the shell prompt, press Enter, wait for the screen to settle and return it with its summary '
      + '— one call. For shell prompts only; in full-screen programs and menus use send_keys. Long-running commands return '
      + '`settled: false` at `timeout_ms` (default 8000); call get_screen again later. Commands that end the shell '
      + '(exit, logout, exec, kill $$) are refused unless force; so is typing a command while a menu is on screen. '
      + 'Example: {target: "a1", command: "ls -la"}; {command: "npm test", timeout_ms: 60000}.',
    schema: z.object({
      ...TARGETED,
      command: z.string().min(1).max(8_192).describe('The command line, without a trailing newline.'),
      settle_ms: SETTLE.optional(),
      timeout_ms: TIMEOUT.optional(),
      scrollback_lines: SCROLL.optional(),
      force: FORCE,
    }),
    annotations: WRITE,
    run: async (a) => {
      // A wrapper over act (TM-11): same guard (plus the menu check), one input batch, same screen result.
      const r = await resolve(a);
      const steps: InputStep[] = [{ text: a.command.replace(/\r?\n$/, '') }, { key: 'Enter' }];
      const res = await actOn(r, {
        steps, force: a.force, refuseOnMenu: true,
        scrollback: a.scrollback_lines, settleMs: a.settle_ms ?? 300, timeoutMs: a.timeout_ms ?? 8_000,
      });
      if ('refused' in res) return res.refused;
      const before = res.out.beforeSummary;
      const warning = !a.force && before.state !== 'shell_prompt'
        ? `the session was not at a shell prompt (program=${before.program}, state=${before.state}); the text went to that program`
        : undefined;
      return screenResult(res.out.after, r, warning ? { warning } : {});
    },
  }),

  define({
    name: 'act',
    title: 'Act and verify',
    description:
      'Do one thing in any terminal program and see what it did, in ONE call — the general tool for text inputs, '
      + 'yes/no questions, editors and other full-screen programs; use it instead of type_text/send_keys followed by '
      + 'get_screen. Reads the screen, applies the safety guard, sends ONE input (`text`, then `keys`, then '
      + 'Enter if `enter`), waits until the screen settles (`settle_ms`, default 200) or until `wait_for` appears on a NEW '
      + 'row (plain text, or "/regex/flags"), and returns the state after (program, state, menu) plus `changed_rows`. '
      + 'Examples: answer a text prompt {text: "yes", enter: true}; answer a [y/N] question {text: "y", enter: true}; move in a list {keys: ["Down", "Down"]}; save and '
      + 'quit an editor {keys: ["Escape", ":wq", "Enter"]}; a slow command {text: "npm test", enter: true, wait_for: '
      + '"/passing|failing/", timeout_ms: 20000}. `return`: "summary" (default), "diff" (changed rows with their '
      + '`before` text) or "screen" (the full grid too). `keys` items that are not key names are typed literally. '
      + 'Refused (nothing sent) like send_keys: exit/logout/Ctrl+D at a shell prompt and confirming a destructive menu '
      + 'option, unless `force`. `settled: false` / `wait_for.matched: false` means `timeout_ms` (default 4000) ran out '
      + '— call get_screen later. Picking a menu option by name: select_option.',
    schema: z.object({
      ...TARGETED,
      text: z.string().min(1).max(65_536).optional().describe('Characters to type first.'),
      keys: z.array(z.string().min(1)).min(1).max(64).optional().describe('Then these key names / literal text items, e.g. ["Down", "Enter"].'),
      enter: z.boolean().optional().describe('Finally press Enter.'),
      paste: z.boolean().optional().describe('Deliver `text` as a bracketed paste (multi-line text).'),
      wait_for: z.string().min(1).max(512).optional().describe('Wait until this text (or "/regex/flags") is on a new row instead of waiting for the screen to settle.'),
      settle_ms: SETTLE.optional(),
      timeout_ms: TIMEOUT.optional(),
      return: z.enum(['summary', 'screen', 'diff']).optional().describe('Result shape (default "summary").'),
      force: FORCE,
    }),
    annotations: WRITE,
    run: async (a) => {
      const steps: InputStep[] = [
        ...(a.text !== undefined ? [{ text: a.text }] : []),
        ...(a.keys ? keysToSteps(a.keys) : []),
        ...(a.enter ? [{ key: 'Enter' }] : []),
      ];
      if (!steps.length) return failWith({ code: 'bad-arguments', message: 'act needs `text`, `keys` or `enter: true`.', hint: 'To only read the screen use get_status or get_screen.' });
      if (a.wait_for !== undefined) {
        try { waitMatcher(a.wait_for); }
        catch (err) { return failWith({ code: 'bad-arguments', message: `wait_for is not a valid /regex/: ${err instanceof Error ? err.message : String(err)}`, hint: 'Pass plain text, or a valid "/regex/flags".' }); }
      }
      const r = await resolve(a);
      const res = await actOn(r, {
        steps, paste: a.paste, force: a.force, waitFor: a.wait_for,
        settleMs: a.settle_ms ?? ACT_DEFAULTS.settleMs, timeoutMs: a.timeout_ms ?? ACT_DEFAULTS.timeoutMs,
      });
      if ('refused' in res) return res.refused;
      const { out } = res;
      const mode = a.return ?? 'summary';
      const changed_rows = mode === 'diff' ? out.changed : out.changed.map(({ row, text }) => ({ row, text }));
      const extra = {
        sent: out.sent, before: { program: out.beforeSummary.program, state: out.beforeSummary.state },
        changed_rows, ...(out.waitFor ? { wait_for: out.waitFor } : {}), elapsed_ms: out.elapsedMs,
      };
      if (mode === 'screen') return screenResult(out.after, r, extra);
      return ok({
        ...targetInfo(r), ...extra, summary: out.summary, settled: out.after.settled,
        command: out.after.command, mode: out.after.mode, cursor: out.after.cursor, inUse: out.after.inUse,
      });
    },
  }),
];

const ALL_TOOLS = REVIEW_MODE ? [...TOOLS, ...DIALOG_TOOLS] : TOOLS;
const BY_NAME = new Map([...TOOLS, ...DIALOG_TOOLS].map((t) => [t.name, t]));

// ── Server ──────────────────────────────────────────────────────────────────

export function buildTerminalServer(): Server {
  const server = new Server(
    { name: 'aura-terminal', version: '1.1.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS + MENU_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS.map(({ name, title, description, inputSchema, annotations }): Tool =>
      ({ name, title, description, inputSchema, annotations })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    // Hidden dialog tools still answer, so an agent with an old tool list keeps working.
    const tool = BY_NAME.get(req.params.name);
    if (!tool) return failWith({ code: 'unknown-tool', message: `Unknown tool "${req.params.name}".`, hint: `Tools: ${ALL_TOOLS.map((t) => t.name).join(', ')}` });
    try { return await tool.run((req.params.arguments ?? {}) as Record<string, unknown>); }
    catch (err) { return errorResult(err, tool.name); }
  });

  return server;
}
