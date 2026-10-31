import { WebSocketServer, WebSocket } from 'ws';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const LOG_FILE = process.env['AURA_CONSOLE_LOG'] ?? '/data/console.log';
const MAX_TAIL_ENTRIES = 500;

export interface LogEntry {
  type: string;
  level: string;
  timestamp: number;
  source: string;
  args: string[];
}

export function isLogEntry(x: unknown): x is LogEntry {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o['type'] === 'string' &&
    typeof o['level'] === 'string' &&
    typeof o['timestamp'] === 'number' &&
    typeof o['source'] === 'string' &&
    Array.isArray(o['args'])
  );
}

// Module state lives on globalThis: an in-process Astro restart (any edit to
// a config) loads this module a second time, and the MCP route (src/mcp/logs.ts)
// may be served by a different module instance than the one the /ws upgrade
// hook holds. One shared state means `onLogEntry` always sees the live feed.
type State = { wss: WebSocketServer | null; clients: Set<WebSocket>; listeners: Set<(e: LogEntry) => void> };
const KEY = Symbol.for('aura.console.logServer');
const g = globalThis as unknown as Record<symbol, State | undefined>;
const state: State = g[KEY] ??= { wss: null, clients: new Set(), listeners: new Set() };

export function getLogWss(): WebSocketServer {
  if (state.wss) return state.wss;
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  const wss = new WebSocketServer({ noServer: true });
  const { clients } = state;

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('message', (msg: Buffer | string) => {
      try {
        const parsed = JSON.parse(msg.toString()) as unknown;
        if (!isLogEntry(parsed)) return;
        appendFileSync(LOG_FILE, JSON.stringify(parsed) + '\n');
        for (const c of clients) {
          if (c !== ws && c.readyState === WebSocket.OPEN) {
            try { c.send(JSON.stringify(parsed)); } catch { /* ignore */ }
          }
        }
        emitLogEntry(parsed);
      } catch { /* malformed payload — silently drop */ }
    });
    ws.on('close', () => { clients.delete(ws); });
    ws.on('error', () => { clients.delete(ws); });
  });

  state.wss = wss;
  console.log(`[console] log WebSocket ready (file=${LOG_FILE})`);
  return wss;
}

/** Subscribe to entries as they arrive (the MCP's wait_for_log). Returns the
 *  unsubscribe function. Listeners never see history. */
export function onLogEntry(cb: (e: LogEntry) => void): () => void {
  state.listeners.add(cb);
  return () => { state.listeners.delete(cb); };
}

/** Hand an entry to the listeners (also used by tests to simulate arrivals). */
export function emitLogEntry(e: LogEntry): void {
  for (const l of state.listeners) {
    try { l(e); } catch { /* a listener's problem, not the feed's */ }
  }
}

export function tailLogFile(maxEntries = MAX_TAIL_ENTRIES): LogEntry[] {
  if (!existsSync(LOG_FILE)) return [];
  const text = readFileSync(LOG_FILE, 'utf-8');
  const lines = text.split('\n').filter(Boolean).slice(-maxEntries);
  const out: LogEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isLogEntry(parsed)) out.push(parsed);
    } catch { /* skip malformed */ }
  }
  return out;
}

export function getLogFilePath(): string {
  return LOG_FILE;
}
