import { WebSocketServer, WebSocket } from 'ws';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const LOG_FILE = process.env['AURA_CONSOLE_LOG'] ?? '/data/console.log';
const MAX_TAIL_ENTRIES = 500;

interface LogEntry {
  type: string;
  level: string;
  timestamp: number;
  source: string;
  args: string[];
}

function isLogEntry(x: unknown): x is LogEntry {
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

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

export function getLogWss(): WebSocketServer {
  if (wss) return wss;
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  wss = new WebSocketServer({ noServer: true });

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
      } catch { /* malformed payload — silently drop */ }
    });
    ws.on('close', () => { clients.delete(ws); });
    ws.on('error', () => { clients.delete(ws); });
  });

  console.log(`[console] log WebSocket ready (file=${LOG_FILE})`);
  return wss;
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
