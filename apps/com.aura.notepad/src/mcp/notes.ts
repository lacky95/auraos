/**
 * `aura-notepad` — the Notepad as one MCP server.
 *
 * Two layers, one tool list:
 *
 *   • TABS — the buffers open in the notepad right now. Untitled ones
 *     ("new 1", "new 2", …) exist only here; named ones mirror a file under
 *     the notes root. Every tab tool goes through `state.ts`, whose mutations
 *     broadcast to the SSE stream each window listens on, so a write lands in
 *     every open editor live — exactly like a keystroke would.
 *
 *   • SAVED NOTES — the tree under FILES_DIR, served by
 *     `@modelcontextprotocol/server-filesystem` (see `filesystem.ts`). Its
 *     tools are forwarded verbatim. What makes the two layers behave as one
 *     is the live hook after each forwarded write: a `write_file`/`edit_file`
 *     on a file that is open refreshes that tab from disk, and a `move_file`
 *     repoints the tab, so the editor never shows a stale buffer for a file an
 *     agent just changed underneath it.
 *
 * Built on the low-level `Server` rather than `McpServer`: the high-level API
 * only accepts Zod schemas, and the forwarded tools arrive as JSON Schema.
 * Our own tools are written as Zod objects and converted once at module load.
 *
 * Registration: `app.manifest.json` declares this server under `provides`
 * (kind `mcp`, address `/mcp/notes`); the OS materialises it as a live
 * address whenever an instance of the notepad is up. No runtime call needed.
 */
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  closeTab, createTab, findTab, loadFile, refreshTabFromDisk, relocateTabs, removeTabsUnder,
  saveTabToPath, setActiveTab, setTabText, state,
} from '../state.js';
import type { Tab } from '../state.js';
import { notePath, relPath } from '../paths.js';
import { callFsTool, listFsTools } from './filesystem.js';

const INSTRUCTIONS =
  'The AuraOS Notepad. Two layers share this tool list. '
  + 'TABS are the buffers currently open in the notepad; untitled ones are named "new N" and exist only here until '
  + 'save_tab gives them a path. Tab writes (write_tab, edit_tab) appear live in every open notepad window. '
  + 'SAVED NOTES are plain files under the notes root (/data/files); use the filesystem tools '
  + '(list_directory, read_text_file, write_file, edit_file, search_files, move_file, …) with paths relative to that root. '
  + 'A saved note that is also open as a tab is refreshed in the editor after write_file/edit_file/move_file. '
  + 'write_file does not create missing folders — call create_directory first, or new_tab with a path (which does). '
  + 'Every `tab` argument accepts a tab id, a tab name (case-insensitive, e.g. "new 2"), or a note path.';

// ── Result helpers ──────────────────────────────────────────────────────────

/** Tool result carrying the same payload as text (for any client) and as structured content. */
function ok(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function tabView(t: Tab) {
  return {
    id:       t.id,
    name:     t.name,
    path:     t.path ? relPath(t.path) : null,
    untitled: t.path === null,
    revision: t.revision,
    chars:    t.text.length,
  };
}

/** Resolve a `tab` argument or explain why it didn't match. */
function needTab(ref: string): Tab | CallToolResult {
  const tab = findTab(ref);
  if (tab) return tab;
  const names = state.tabs.map(t => `${t.name} (${t.id})`).join(', ');
  return fail(`No open tab matches "${ref}". Open tabs: ${names || '(none)'}.`);
}

function isResult(x: Tab | CallToolResult): x is CallToolResult {
  return 'content' in x;
}

/** Optimistic-concurrency check shared by the tab writers. */
function revisionMismatch(tab: Tab, expected: number | undefined): CallToolResult | null {
  if (expected === undefined || expected === tab.revision) return null;
  return fail(
    `Revision mismatch on "${tab.name}": expected ${expected}, current is ${tab.revision}. `
    + 'Re-read the tab and retry with the current revision.',
  );
}

// ── Own tools ───────────────────────────────────────────────────────────────

const TAB_ARG = z.string().min(1).describe('Tab id, tab name (case-insensitive, e.g. "new 2"), or note path.');
const PATH_ARG = z.string().min(1).describe('Note path relative to the notes root, e.g. "ideas/todo.txt".');

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
        const issues = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        return fail(`Invalid arguments for ${opts.name}: ${issues}`);
      }
      return opts.run(parsed.data);
    },
  };
}

const READ:  ToolAnnotations = { readOnlyHint: true, idempotentHint: true };

const OWN_TOOLS: OwnTool[] = [
  define({
    name: 'list_tabs',
    title: 'List open tabs',
    description:
      'Every tab open in the notepad — untitled buffers ("new N", not on disk) and saved notes alike — with id, '
      + 'name, path (relative to the notes root, null when untitled), revision and size. `defaultActiveId` is the '
      + 'tab a freshly opened window shows first.',
    schema: z.object({}),
    annotations: READ,
    run: () => ok({ tabs: state.tabs.map(tabView), defaultActiveId: state.activeTabId }),
  }),

  define({
    name: 'read_tab',
    title: 'Read a tab',
    description: 'The full text of one open tab plus its metadata. Works for unsaved tabs too.',
    schema: z.object({ tab: TAB_ARG }),
    annotations: READ,
    run: ({ tab: ref }) => {
      const tab = needTab(ref);
      if (isResult(tab)) return tab;
      return ok({ ...tabView(tab), text: tab.text });
    },
  }),

  define({
    name: 'write_tab',
    title: 'Write a tab',
    description:
      'Replace (default) or append to the text of an open tab. The change is pushed live to every notepad '
      + 'window and auto-saved (to the note file for saved tabs, to the notepad cache for untitled ones). '
      + 'Pass `expectedRevision` from a previous read to refuse the write if someone edited in between.',
    schema: z.object({
      tab:  TAB_ARG,
      text: z.string().describe('New content (replace) or content to add at the end (append).'),
      mode: z.enum(['replace', 'append']).default('replace'),
      expectedRevision: z.number().int().optional().describe('Only write if the tab is still at this revision.'),
    }),
    annotations: { idempotentHint: false, destructiveHint: true },
    run: ({ tab: ref, text, mode, expectedRevision }) => {
      const tab = needTab(ref);
      if (isResult(tab)) return tab;
      const conflict = revisionMismatch(tab, expectedRevision);
      if (conflict) return conflict;
      setTabText(tab.id, mode === 'append' ? tab.text + text : text);
      return ok(tabView(tab));
    },
  }),

  define({
    name: 'edit_tab',
    title: 'Edit a tab',
    description:
      'Surgical edits to an open tab: each `oldText` must occur exactly once and is replaced by `newText`. '
      + 'All edits are validated before any is applied; on failure nothing changes. Pushed live like write_tab.',
    schema: z.object({
      tab:   TAB_ARG,
      edits: z.array(z.object({
        oldText: z.string().min(1).describe('Exact text to find (must be unique in the tab).'),
        newText: z.string().describe('Replacement text (may be empty to delete).'),
      })).min(1),
      expectedRevision: z.number().int().optional().describe('Only edit if the tab is still at this revision.'),
    }),
    annotations: { idempotentHint: false, destructiveHint: true },
    run: ({ tab: ref, edits, expectedRevision }) => {
      const tab = needTab(ref);
      if (isResult(tab)) return tab;
      const conflict = revisionMismatch(tab, expectedRevision);
      if (conflict) return conflict;
      let text = tab.text;
      const problems: string[] = [];
      edits.forEach((e, i) => {
        const count = text.split(e.oldText).length - 1;
        if (count !== 1) {
          problems.push(`edit ${i + 1}: "${e.oldText.slice(0, 60)}" found ${count} times (need exactly 1)`);
          return;
        }
        text = text.replace(e.oldText, () => e.newText);
      });
      if (problems.length > 0) return fail(`Nothing applied. ${problems.join('; ')}.`);
      setTabText(tab.id, text);
      return ok({ ...tabView(tab), applied: edits.length });
    },
  }),

  define({
    name: 'new_tab',
    title: 'New tab',
    description:
      'Open a new tab. Without `path` it is an untitled buffer ("new N") that lives only in the notepad. '
      + 'With `path` it creates that note file (folders are created as needed) and opens it as a saved tab; '
      + 'fails if the file already exists — use open_note for that.',
    schema: z.object({
      text: z.string().optional().describe('Initial content.'),
      path: PATH_ARG.optional(),
    }),
    annotations: { idempotentHint: false },
    run: ({ text, path }) => {
      if (path === undefined) {
        const tab = createTab();
        if (text) setTabText(tab.id, text);
        return ok(tabView(tab));
      }
      const abs = notePath(path);
      if (!abs) return fail(`Invalid note path "${path}".`);
      if (existsSync(abs)) return fail(`"${relPath(abs)}" already exists. Use open_note to open it, or write_file to overwrite it.`);
      mkdirSync(dirname(abs), { recursive: true });
      const id = loadFile(abs, basename(abs), text ?? '');
      setTabText(id, text ?? '');            // writes the file, since the tab now has a path
      return ok(tabView(state.tabs.find(t => t.id === id)!));
    },
  }),

  define({
    name: 'open_note',
    title: 'Open a saved note',
    description:
      'Open a note file from the notes root as a tab (and make it the default tab for new windows). '
      + 'If the file is already open, that tab is returned instead of a duplicate.',
    schema: z.object({ path: PATH_ARG }),
    annotations: { idempotentHint: true },
    run: ({ path }) => {
      const abs = notePath(path);
      if (!abs) return fail(`Invalid note path "${path}".`);
      if (!existsSync(abs) || !statSync(abs).isFile()) return fail(`No note at "${relPath(abs)}".`);
      const already = state.tabs.find(t => t.path === abs);
      const id = already ? loadFile(abs, already.name, already.text) : loadFile(abs, basename(abs), '');
      const tab = already ?? refreshTabFromDisk(abs) ?? state.tabs.find(t => t.id === id)!;
      return ok({ ...tabView(tab), reused: Boolean(already) });
    },
  }),

  define({
    name: 'save_tab',
    title: 'Save a tab to a path',
    description:
      'Give an untitled tab a file under the notes root (it becomes a saved note and keeps auto-saving there), '
      + 'or save-as an already saved tab to a new path. Fails if another open tab already holds that path.',
    schema: z.object({ tab: TAB_ARG, path: PATH_ARG }),
    annotations: { idempotentHint: true },
    run: ({ tab: ref, path }) => {
      const tab = needTab(ref);
      if (isResult(tab)) return tab;
      const abs = notePath(path);
      if (!abs) return fail(`Invalid note path "${path}".`);
      const holder = state.tabs.find(t => t.path === abs && t.id !== tab.id);
      if (holder) return fail(`"${relPath(abs)}" is already open as tab "${holder.name}" (${holder.id}).`);
      saveTabToPath(tab.id, abs, basename(abs));
      return ok(tabView(tab));
    },
  }),

  define({
    name: 'close_tab',
    title: 'Close a tab',
    description:
      'Close an open tab. A saved tab keeps its file on disk; an UNTITLED tab\'s content is discarded — '
      + 'save_tab it first if it matters. The notepad always keeps at least one tab open.',
    schema: z.object({ tab: TAB_ARG }),
    annotations: { destructiveHint: true, idempotentHint: true },
    run: ({ tab: ref }) => {
      const tab = needTab(ref);
      if (isResult(tab)) return tab;
      const view = tabView(tab);
      closeTab(tab.id);
      return ok({ closed: view, remaining: state.tabs.length });
    },
  }),

  define({
    name: 'focus_tab',
    title: 'Focus a tab',
    description:
      'Make a tab the default one — what a newly opened notepad window shows first. '
      + 'Windows that are already open keep their own selection.',
    schema: z.object({ tab: TAB_ARG }),
    annotations: { idempotentHint: true },
    run: ({ tab: ref }) => {
      const tab = needTab(ref);
      if (isResult(tab)) return tab;
      setActiveTab(tab.id);
      return ok({ defaultActiveId: state.activeTabId });
    },
  }),

  define({
    name: 'delete_note',
    title: 'Delete a saved note',
    description:
      'Delete a note file or folder (recursively) under the notes root, closing any tab that had it open. '
      + 'Permanent — there is no trash.',
    schema: z.object({ path: PATH_ARG }),
    annotations: { destructiveHint: true, idempotentHint: true },
    run: ({ path }) => {
      const abs = notePath(path);
      if (!abs) return fail(`Invalid note path "${path}".`);
      if (abs === notePath('.')) return fail('Refusing to delete the notes root itself.');
      if (!existsSync(abs)) return fail(`No note at "${relPath(abs)}".`);
      rmSync(abs, { recursive: true, force: true });
      const closedTabs = removeTabsUnder(abs);
      return ok({ deleted: relPath(abs), closedTabs });
    },
  }),
];

const OWN_BY_NAME = new Map(OWN_TOOLS.map(t => [t.name, t]));

// ── Live hook for forwarded writes ──────────────────────────────────────────

/**
 * After the filesystem server changed something on disk, bring the open tabs
 * back in line. Only on success, and never for `edit_file`'s dry run.
 */
function syncTabsAfter(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  if (name === 'write_file' || (name === 'edit_file' && args['dryRun'] !== true)) {
    const abs = notePath(str(args['path']));
    const tab = abs ? refreshTabFromDisk(abs) : undefined;
    return tab ? { refreshedTab: tabView(tab) } : {};
  }
  if (name === 'move_file') {
    const src = notePath(str(args['source']));
    const dst = notePath(str(args['destination']));
    const moved = src && dst ? relocateTabs(src, dst) : [];
    return moved.length > 0 ? { movedTabs: moved.map(tabView) } : {};
  }
  return {};
}

// ── Server ──────────────────────────────────────────────────────────────────

async function forwardedTools(): Promise<Tool[]> {
  try {
    return await listFsTools();
  } catch (err) {
    // The tab tools must keep working even if the filesystem child is broken.
    console.error(`[notes-mcp] filesystem tools unavailable: ${(err as Error).message}`);
    return [];
  }
}

export function buildNotesServer(): Server {
  const server = new Server(
    { name: 'aura-notepad', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...OWN_TOOLS.map(({ name, title, description, inputSchema, annotations }): Tool =>
        ({ name, title, description, inputSchema, annotations })),
      ...await forwardedTools(),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    const own = OWN_BY_NAME.get(name);
    if (own) {
      try { return await own.run(args); }
      catch (err) { return fail(`${name} failed: ${(err as Error).message}`); }
    }

    const known = (await forwardedTools()).some(t => t.name === name);
    if (!known) return fail(`Unknown tool "${name}".`);
    let result: CallToolResult;
    try { result = await callFsTool(name, args); }
    catch (err) { return fail(`${name} failed: ${(err as Error).message}`); }
    if (result.isError) return result;

    const sync = syncTabsAfter(name, args);
    if (Object.keys(sync).length === 0) return result;
    // Tell the caller which open tab(s) just followed the change on disk.
    return {
      ...result,
      content: [...result.content, { type: 'text', text: JSON.stringify(sync) }],
      structuredContent: { ...(result.structuredContent ?? {}), ...sync },
    };
  });

  return server;
}
