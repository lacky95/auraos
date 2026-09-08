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
 * Sessions are addressed by their full id, `<instanceId>#a<n>`. Whichever
 * instance serves the request acts on its own sessions directly and forwards
 * the rest to the owning container (session-router.ts), so the agent only
 * ever connects once.
 *
 * Built on the low-level `Server` like the Notepad's MCP: tools are written
 * as Zod objects and converted once at module load, and every tool body is
 * caught so a missing session or a dead container comes back as an `isError`
 * result the agent can read, never as a transport failure.
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
import { inputFor, killFor, listInstances, openOn, screenFor } from '../session-router.ts';
import { LIMITS } from '../session-service.ts';
import type { ScreenView } from '../session-service.ts';
import { KEY_HELP } from '../tmux-control.ts';

const INSTRUCTIONS =
  'Live terminal sessions across every AuraOS terminal instance. A session id is `<instanceId>#a<n>` '
  + '(e.g. `com.aura.terminal-2#a3`); call list_sessions first to see what exists. '
  + '`screen` is a `rows × cols` text grid, row 0 at the top, every line padded to `cols`; `cursor` is 0-based. '
  + '`mode: "alternate"` means a full-screen program (vim, htop, less, an interactive CLI) owns the screen: '
  + 'drive it with send_keys (arrows, Enter, Escape, Ctrl+C, q …) and read the bottom rows for its key legend. '
  + 'In `mode: "normal"` prefer run_command, and ask for `scrollback_lines` when output has scrolled off the grid. '
  + '`inUse: true` means a human has that session open in a window and sees every keystroke as it happens. '
  + '`settled: false` means the screen was still changing when `timeout_ms` ran out (a spinner, a long build). '
  + 'type_text never presses Enter — send_keys ["Enter"] does. kill_session ends the shell for the human too.';

// ── Result helpers ──────────────────────────────────────────────────────────

function ok(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** A screen as text an agent can read at a glance, plus the full record. */
function screenResult(view: ScreenView): CallToolResult {
  const header =
    `[${view.id}] ${view.mode} ${view.cols}x${view.rows} cursor=(${view.cursor.x},${view.cursor.y}) `
    + `command=${view.command} inUse=${view.inUse} settled=${view.settled}`
    + (view.scrollback.length ? ` scrollback=${view.scrollback.length} lines` : '');
  const parts = [header];
  if (view.scrollback.length) parts.push('--- scrollback ---', ...view.scrollback);
  parts.push('--- screen ---', ...view.screen);
  return {
    content: [{ type: 'text', text: parts.join('\n') }],
    structuredContent: view as unknown as Record<string, unknown>,
  };
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
        return fail(`Invalid arguments for ${opts.name}: ${issues}`);
      }
      return opts.run(parsed.data);
    },
  };
}

const READ:  ToolAnnotations = { readOnlyHint: true, idempotentHint: true };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };
const KILL:  ToolAnnotations = { readOnlyHint: false, destructiveHint: true };

const SESSION = z.string().min(1).describe('Session id, `<instanceId>#a<n>` — from list_sessions.');
const SETTLE  = z.number().int().min(0).max(LIMITS.settleMs)
  .describe('Return once the screen has been unchanged for this many ms (0 = read once, immediately).');
const TIMEOUT = z.number().int().min(100).max(LIMITS.timeoutMs)
  .describe('Give up waiting for the screen to settle after this many ms and return the latest frame.');
const SCROLL  = z.number().int().min(0).max(LIMITS.scrollback)
  .describe('Also return up to this many lines of scrollback from above the visible grid.');

const TOOLS: OwnTool[] = [
  define({
    name: 'list_sessions',
    title: 'List terminal sessions',
    description:
      'Every terminal session on every running terminal instance, grouped by instance. Each session carries '
      + 'its id, whether a human window is rendering it (`inUse`), the pane size, whether a full-screen '
      + 'program is active (`alternate`), the foreground `command` and the window `title`. An instance that '
      + 'could not be reached is listed with `reachable: false` and the reason.',
    schema: z.object({}),
    annotations: READ,
    run: async () => ok({ instances: await listInstances() }),
  }),

  define({
    name: 'open_session',
    title: 'Open a session',
    description:
      'Start a new shell. It has no window yet — it appears in the session picker of every terminal window, '
      + 'and a human can attach to it there. `instance` picks the container: omit it for the instance serving '
      + 'this call, give an instance id, or "new" to start another terminal container first (subject to the '
      + 'app\'s maxInstances). Returns the session id to use with the other tools.',
    schema: z.object({
      instance: z.string().min(1).optional().describe('Instance id (`com.aura.terminal-<n>`), or "new".'),
      cols: z.number().int().min(LIMITS.cols.min).max(LIMITS.cols.max).optional().describe('Initial width, default 80.'),
      rows: z.number().int().min(LIMITS.rows.min).max(LIMITS.rows.max).optional().describe('Initial height, default 24.'),
    }),
    annotations: WRITE,
    run: async ({ instance, cols, rows }) => ok(await openOn(instance, { cols, rows })),
  }),

  define({
    name: 'kill_session',
    title: 'Kill a session',
    description:
      'End a shell for good: kills the tmux session, the process tree in it and its saved scrollback. '
      + 'If a human has the session open, their window goes dark. Prefer sending Ctrl+C or "exit" when '
      + 'you only want to stop what is running.',
    schema: z.object({ session: SESSION }),
    annotations: KILL,
    run: async ({ session }) => ok(await killFor(session)),
  }),

  define({
    name: 'get_screen',
    title: 'Read the screen',
    description:
      'The session\'s screen as the human sees it: a `rows × cols` grid of text lines, the cursor position, '
      + '`mode` ("normal" shell, or "alternate" when a full-screen program owns the screen), the foreground '
      + 'command, and optionally the last `scrollback_lines` lines that scrolled off the top. By default it '
      + 'waits until the screen has been still for `settle_ms`, so a command\'s output is complete when you read it.',
    schema: z.object({
      session: SESSION,
      scrollback_lines: SCROLL.optional(),
      settle_ms: SETTLE.optional(),
      timeout_ms: TIMEOUT.optional(),
    }),
    annotations: READ,
    run: async ({ session, scrollback_lines, settle_ms, timeout_ms }) =>
      screenResult(await screenFor(session, { scrollback: scrollback_lines, settleMs: settle_ms, timeoutMs: timeout_ms })),
  }),

  define({
    name: 'type_text',
    title: 'Type text',
    description:
      'Type text into the session exactly as given, character for character. Does NOT press Enter — follow '
      + 'with send_keys ["Enter"] to submit, or use run_command for a shell command. `paste: true` delivers '
      + 'the text as a bracketed paste, which is what you want for multi-line text into an editor or a shell '
      + 'prompt (it is inserted, not executed line by line).',
    schema: z.object({
      session: SESSION,
      text: z.string().min(1).max(65_536).describe('The characters to type.'),
      paste: z.boolean().optional().describe('Deliver as a bracketed paste instead of keystrokes.'),
    }),
    annotations: WRITE,
    run: async ({ session, text, paste }) => ok(await inputFor(session, { text, paste }) as unknown as Record<string, unknown>),
  }),

  define({
    name: 'send_keys',
    title: 'Send keys',
    description:
      'Press keys in the session, in order — for navigating full-screen programs and for control keys. '
      + `Accepted names: ${KEY_HELP} Unknown names are rejected before anything is sent.`,
    schema: z.object({
      session: SESSION,
      keys: z.array(z.string().min(1)).min(1).max(64).describe('Key names, e.g. ["Ctrl+C"], ["Escape", ":wq", "Enter"] — note a multi-character string that is not a key name is rejected; type words with type_text.'),
    }),
    annotations: WRITE,
    run: async ({ session, keys }) => ok(await inputFor(session, { keys }) as unknown as Record<string, unknown>),
  }),

  define({
    name: 'run_command',
    title: 'Run a shell command',
    description:
      'Type a command at the shell prompt, press Enter, wait for the screen to settle and return it — '
      + 'type_text + send_keys ["Enter"] + get_screen in one call. For `mode: "normal"` sessions only; '
      + 'in a full-screen program use send_keys. Long-running commands return `settled: false` at `timeout_ms` '
      + 'with whatever is on screen; call get_screen again later.',
    schema: z.object({
      session: SESSION,
      command: z.string().min(1).max(8_192).describe('The command line, without a trailing newline.'),
      settle_ms: SETTLE.optional(),
      timeout_ms: TIMEOUT.optional(),
      scrollback_lines: SCROLL.optional(),
    }),
    annotations: WRITE,
    run: async ({ session, command, settle_ms, timeout_ms, scrollback_lines }) => {
      await inputFor(session, { text: command.replace(/\r?\n$/, ''), keys: ['Enter'] });
      return screenResult(await screenFor(session, {
        scrollback: scrollback_lines, settleMs: settle_ms ?? 400, timeoutMs: timeout_ms ?? 10_000,
      }));
    },
  }),
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ── Server ──────────────────────────────────────────────────────────────────

export function buildTerminalServer(): Server {
  const server = new Server(
    { name: 'aura-terminal', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, title, description, inputSchema, annotations }): Tool =>
      ({ name, title, description, inputSchema, annotations })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = BY_NAME.get(req.params.name);
    if (!tool) return fail(`Unknown tool "${req.params.name}".`);
    try { return await tool.run((req.params.arguments ?? {}) as Record<string, unknown>); }
    catch (err) { return fail(`${tool.name} failed: ${(err as Error).message}`); }
  });

  return server;
}
