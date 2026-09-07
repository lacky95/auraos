/**
 * Bridge to `@modelcontextprotocol/server-filesystem`, rooted at the
 * saved-notes tree (`FILES_DIR`). The package is bin-only, so it runs as a
 * stdio child process and we talk to it with the SDK's client; the combined
 * notes server forwards its tools verbatim.
 *
 * One child per Astro process, kept on `globalThis` (the same trick
 * `state.ts` uses) so it outlives the per-request servers `createMcpRoute`
 * builds. It is spawned lazily on the first filesystem call and respawned on
 * the next call after it exits. When the Astro process itself dies the child
 * sees EOF on stdin and exits — no orphans.
 */
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { FILES_DIR } from '../state.js';

/**
 * Not forwarded: `read_file` is a deprecated alias of `read_text_file`,
 * `read_media_file` is for images/audio (notes are text), and
 * `list_allowed_directories` would only ever answer "the notes root".
 */
const HIDDEN = new Set(['read_file', 'read_media_file', 'list_allowed_directories']);

const PATH_NOTE = ' Paths are relative to the notes root (/data/files); absolute paths under it also work.';

interface Bridge {
  client: Client;
  tools: Promise<Tool[]> | null;
}

const KEY = '__aura_notepad_fs_bridge__';
const g = globalThis as typeof globalThis & { [KEY]?: Promise<Bridge> | null };

async function spawnBridge(): Promise<Bridge> {
  const bin = createRequire(import.meta.url)
    .resolve('@modelcontextprotocol/server-filesystem/dist/index.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, FILES_DIR],
    cwd: FILES_DIR,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'notepad-fs-bridge', version: '1.0.0' });
  await client.connect(transport);
  transport.stderr?.on('data', (chunk: Buffer) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) console.log(`[notes-mcp fs] ${line}`);
    }
  });
  return { client, tools: null };
}

function getBridge(): Promise<Bridge> {
  if (!g[KEY]) {
    const pending = spawnBridge();
    g[KEY] = pending;
    pending.then((bridge) => {
      bridge.client.onclose = () => {
        console.warn('[notes-mcp fs] filesystem server exited; it will be respawned on the next call');
        if (g[KEY] === pending) g[KEY] = null;
      };
    }).catch((err: unknown) => {
      console.error(`[notes-mcp fs] failed to start filesystem server: ${(err as Error).message}`);
      if (g[KEY] === pending) g[KEY] = null;
    });
  }
  return g[KEY]!;
}

/** The forwarded tool list, as the child describes it (minus HIDDEN), with the path convention appended. */
export async function listFsTools(): Promise<Tool[]> {
  const bridge = await getBridge();
  bridge.tools ??= bridge.client.listTools().then((res) =>
    res.tools
      .filter((t) => !HIDDEN.has(t.name))
      .map((t) => ({ ...t, description: (t.description ?? '').trimEnd() + PATH_NOTE })),
  );
  return bridge.tools;
}

export async function callFsTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const bridge = await getBridge();
  return await bridge.client.callTool({ name, arguments: args }) as CallToolResult;
}
