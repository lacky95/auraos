/**
 * The Console's MCP: query the logs it collected from the shell and every
 * app iframe. Advertised through the manifest's `provides` entry `logs`
 * (kind `http/mcp`, address `/mcp/logs`); the OS exposes it at
 * /api/proxy/com.aura.console/mcp/logs and cold-starts the app for it.
 *
 * Reads go through src/log-query.ts, which reads only a tail window of the
 * append-only file. `wait_for_log` taps the live feed (log-server.ts).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getLogFilePath, onLogEntry, type LogEntry } from '../log-server.ts';
import {
  LEVELS, filterEntries, formatEntries, formatEntry, formatSources, parseSince, readTailLines,
  summarizeSources, textMatcher,
} from '../log-query.ts';

const MiB = 1024 * 1024;
const TAIL_WINDOW = 4 * MiB;

// ── Result helpers ──────────────────────────────────────────────────────────

/** Readable text for the model plus the structured record for programs. */
function ok(text: string, payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: payload };
}

function failWith(e: { code: string; message: string; hint?: string }): CallToolResult {
  const lines = [`[${e.code}] ${e.message}`];
  if (e.hint) lines.push(`hint: ${e.hint}`);
  return { isError: true, content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { error: e } };
}

function errorResult(err: unknown, tool: string): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  if (/invalid regex|cannot parse since/.test(message)) return failWith({ code: 'bad-arguments', message: `${tool}: ${message}` });
  return failWith({ code: 'internal', message: `${tool} failed: ${message}` });
}

// ── Tool table ──────────────────────────────────────────────────────────────

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

const READ: ToolAnnotations = { readOnlyHint: true, idempotentHint: true };

const LEVELS_ARG = z.array(z.enum(LEVELS)).optional()
  .describe('Keep only these levels (log, info, warn, error, debug). Omit for all.');
const SOURCE_ARG = z.string().optional()
  .describe('Keep only this source: an appId like "io.lakner.foo", or "shell" for the desktop itself.');
const CONTAINS_ARG = z.string().optional()
  .describe('Case-insensitive substring over source + message, or a regex written /pattern/flags (e.g. "/timeout|ECONN/").');
const SINCE_ARG = z.string().optional()
  .describe('Only entries newer than this: "5m", "2h", "30s", "1d", an ISO date, or epoch ms.');

function filtered(windowBytes: number, a: { levels?: string[]; source?: string; contains?: string; since?: string }) {
  const { entries, truncated } = readTailLines(getLogFilePath(), windowBytes);
  const sinceMs = a.since != null ? parseSince(a.since) : undefined;
  const matched = filterEntries(entries, { levels: a.levels, source: a.source, contains: a.contains, sinceMs });
  return { matched, scanned: entries.length, truncated };
}

function page(matched: LogEntry[], limit: number, scanned: number, truncated: boolean, windowBytes: number) {
  const shown = matched.slice(-limit);
  const window = `last ${Math.round(windowBytes / MiB)} MiB${truncated ? ', older entries exist beyond it' : ', whole file'}`;
  const text = shown.length
    ? `${formatEntries(shown)}\n— ${shown.length} shown of ${matched.length} matched (${scanned} scanned, window: ${window})`
    : `(no matching entries; ${scanned} scanned, window: ${window})`;
  return ok(text, { entries: shown, matched: matched.length, shown: shown.length, scanned, window_truncated: truncated });
}

const TOOLS: OwnTool[] = [
  define({
    name: 'tail_logs',
    title: 'Tail logs',
    description: 'The newest log entries (oldest first), optionally filtered by level, source and text. Reads the last 4 MiB of the log; use search_logs to look further back.',
    schema: z.object({
      limit: z.number().int().min(1).max(2000).default(200).describe('How many of the newest matching entries to return.'),
      levels: LEVELS_ARG, source: SOURCE_ARG, contains: CONTAINS_ARG, since: SINCE_ARG,
    }),
    annotations: READ,
    run: (a) => {
      const { matched, scanned, truncated } = filtered(TAIL_WINDOW, a);
      return page(matched, a.limit, scanned, truncated, TAIL_WINDOW);
    },
  }),
  define({
    name: 'search_logs',
    title: 'Search logs',
    description: 'Find entries matching a query deeper in the log (default: the last 16 MiB). Same filters as tail_logs; the newest matches are returned, oldest first.',
    schema: z.object({
      query: z.string().min(1).describe('Substring (case-insensitive) or /regex/flags, matched against source + message.'),
      limit: z.number().int().min(1).max(2000).default(100),
      levels: LEVELS_ARG, source: SOURCE_ARG, since: SINCE_ARG,
      window_mb: z.number().min(1).max(64).default(16).describe('How many MiB from the end of the log to scan.'),
    }),
    annotations: READ,
    run: (a) => {
      const windowBytes = Math.round(a.window_mb * MiB);
      const { matched, scanned, truncated } = filtered(windowBytes, { levels: a.levels, source: a.source, contains: a.query, since: a.since });
      return page(matched, a.limit, scanned, truncated, windowBytes);
    },
  }),
  define({
    name: 'list_sources',
    title: 'List sources',
    description: 'Who has been logging: per source (appId or "shell") the entry count, error/warn counts and the time of the latest entry, most recently active first. Over the last 4 MiB of the log.',
    schema: z.object({ since: SINCE_ARG }),
    annotations: READ,
    run: (a) => {
      const { matched, scanned, truncated } = filtered(TAIL_WINDOW, a);
      const sources = summarizeSources(matched);
      return ok(formatSources(sources), { sources, scanned, window_truncated: truncated });
    },
  }),
  define({
    name: 'wait_for_log',
    title: 'Wait for a log entry',
    description: 'Block until the next entry matching the filters ARRIVES (entries already in the log do not count), or until timeout_ms. A timeout is a normal result with timed_out=true, not an error. Call it, then trigger the action you want to observe.',
    schema: z.object({
      contains: CONTAINS_ARG, levels: LEVELS_ARG, source: SOURCE_ARG,
      timeout_ms: z.number().int().min(100).max(30_000).default(15_000),
    }),
    annotations: { readOnlyHint: true, idempotentHint: false },
    run: (a) => new Promise<CallToolResult>((resolve) => {
      const levels = a.levels?.length ? new Set<string>(a.levels) : null;
      let match: ((t: string) => boolean) | null;
      try { match = a.contains ? textMatcher(a.contains) : null; }
      catch (err) { resolve(errorResult(err, 'wait_for_log')); return; }
      const started = Date.now();
      const done = (result: CallToolResult) => { clearTimeout(timer); off(); resolve(result); };
      const off = onLogEntry((e) => {
        if (levels && !levels.has(e.level)) return;
        if (a.source != null && e.source !== a.source) return;
        if (match && !match(`${e.source} ${e.args.join(' ')}`)) return;
        done(ok(formatEntry(e), { entry: e, timed_out: false, waited_ms: Date.now() - started }));
      });
      const timer = setTimeout(() => done(ok(`(no matching entry within ${a.timeout_ms} ms)`, { entry: null, timed_out: true, waited_ms: a.timeout_ms })), a.timeout_ms);
    }),
  }),
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const INSTRUCTIONS = [
  'Logs the Console app collected from the AuraOS desktop ("shell") and every app window: console.log/info/warn/error/debug, uncaught errors, failed fetches.',
  'Each entry has a level, a source (the appId of the window it came from, or "shell") and a message.',
  'Start with list_sources to see who is logging, then tail_logs with source/levels; search_logs looks further back.',
  '`contains`/`query` accept a plain substring or /regex/flags; `since` accepts 5m, 2h, 30s, an ISO date or epoch ms.',
  'wait_for_log only sees entries that arrive AFTER the call: start it, then trigger the action, or use tail_logs with since for what already happened.',
].join('\n');

// ── Server ──────────────────────────────────────────────────────────────────

export function buildLogsServer(): Server {
  const server = new Server(
    { name: 'aura-console-logs', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, title, description, inputSchema, annotations }): Tool =>
      ({ name, title, description, inputSchema, annotations })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = BY_NAME.get(req.params.name);
    if (!tool) return failWith({ code: 'unknown-tool', message: `Unknown tool "${req.params.name}".`, hint: `Tools: ${TOOLS.map((t) => t.name).join(', ')}` });
    try { return await tool.run((req.params.arguments ?? {}) as Record<string, unknown>); }
    catch (err) { return errorResult(err, tool.name); }
  });

  return server;
}
