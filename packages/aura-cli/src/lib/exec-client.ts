/**
 * `aura jump`, `aura exec` and `aura logs` through the shell (Phase 5 stream
 * X): the exec bridge's WebSocket (`/api/instances/:id/session`, subprotocol
 * `aura.exec.v1`, shell server/exec-bridge.mjs) and the logs route. No
 * Docker socket in the caller, no dependency: Node 22's global WebSocket.
 *
 * Until 5-main the Docker paths stay as the fallback (lib/enter-sandbox.ts,
 * commands/verbs.ts): the API is used when it is available, and anything that
 * fails before the session is open (an older shell, a refusal, a runtime the
 * bridge cannot enter) falls back. AURA_EXEC_VIA picks one path for
 * comparisons: `api` (no fallback) or `docker` (no API).
 */
import process_ from 'node:process';
import { shellIdentity, shellFetch } from './identity.js';
import { shellUrl } from './shell-url.js';

export const EXEC_SUBPROTOCOL = 'aura.exec.v1';

export type ExecVia = 'auto' | 'api' | 'docker';

/** AURA_EXEC_VIA: `api`, `docker`, or unset/anything else for the default (API first, Docker fallback). */
export function execVia(env: NodeJS.ProcessEnv = process.env): ExecVia {
  const v = (env['AURA_EXEC_VIA'] ?? '').trim().toLowerCase();
  return v === 'api' || v === 'docker' ? v : 'auto';
}

export interface SessionRequest {
  instanceId: string;
  kind: 'jump' | 'exec';
  argv?: string[];
  tty: boolean;
  cwd?: string;
  sidecar?: string;
}

/** The session ended: its exit code (null when the shell could not read one). */
export interface SessionEnded { opened: true; code: number | null }
/** It never opened: why, so the caller can fall back. */
export interface SessionRefused { opened: false; reason: string }

/** The terminal env a session gets (the same four today's `docker exec` passed). */
export function terminalEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    TERM: env['TERM'] ?? 'xterm-256color',
    COLORTERM: env['COLORTERM'] ?? 'truecolor',
    LANG: env['LANG'] ?? 'C.UTF-8',
    LC_ALL: env['LC_ALL'] ?? 'C.UTF-8',
  };
}

export function sessionUrl(instanceId: string, base = shellUrl()): string {
  const u = new URL(`/api/instances/${encodeURIComponent(instanceId)}/session`, base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

const STDIN = 0;

/**
 * Run one session with this process's stdio. Resolves when it ends, or when
 * it could not be opened (then nothing was executed and stdio is untouched,
 * apart from a TTY that is restored).
 */
export interface SessionIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

export function runSession(req: SessionRequest, io: SessionIo = process_): Promise<SessionEnded | SessionRefused> {
  const { stdin, stdout, stderr } = io;
  const path = `/api/instances/${encodeURIComponent(req.instanceId)}/session`;
  const identity = shellIdentity(path, 'GET', 'self');
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      // Node's WebSocket takes headers (undici's WebSocketInit); the DOM type doesn't know them.
      ws = new WebSocket(sessionUrl(req.instanceId), { protocols: [EXEC_SUBPROTOCOL], headers: identity.headers } as unknown as string[]);
    } catch (err) {
      resolve({ opened: false, reason: (err as Error).message });
      return;
    }
    ws.binaryType = 'arraybuffer';
    let opened = false;
    let settled = false;
    let exitCode: number | null = null;
    let raw = false;
    const cleanups: Array<() => void> = [];
    const settle = (r: SessionEnded | SessionRefused) => {
      if (settled) return;
      settled = true;
      for (const c of cleanups.splice(0)) { try { c(); } catch { /* best effort */ } }
      if (raw) { try { stdin.setRawMode(false); } catch { /* not a tty */ } }
      stdin.pause();
      resolve(r);
    };
    const sendJson = (obj: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

    const start = () => {
      if (req.tty && stdin.isTTY) {
        stdin.setRawMode(true);
        raw = true;
        const onResize = () => sendJson({ op: 'resize', cols: stdout.columns, rows: stdout.rows });
        process.on('SIGWINCH', onResize);
        stdout.on('resize', onResize);
        cleanups.push(() => { process.removeListener('SIGWINCH', onResize); stdout.removeListener('resize', onResize); });
      } else {
        // Without a TTY, Ctrl-C is ours: hand it on (the bridge ends the session).
        const onInt = () => sendJson({ op: 'signal', sig: 'INT' });
        const onTerm = () => sendJson({ op: 'signal', sig: 'TERM' });
        process.on('SIGINT', onInt);
        process.on('SIGTERM', onTerm);
        cleanups.push(() => { process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm); });
      }
      const onData = (d: Buffer) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.concat([Buffer.from([STDIN]), d]));
      };
      const onEnd = () => sendJson({ op: 'eof' });
      stdin.on('data', onData);
      stdin.on('end', onEnd);
      cleanups.push(() => { stdin.removeListener('data', onData); stdin.removeListener('end', onEnd); });
      stdin.resume();
    };

    ws.onopen = () => {
      sendJson({
        op: 'open', kind: req.kind, tty: req.tty,
        cols: stdout.columns || 80, rows: stdout.rows || 24,
        env: terminalEnv(),
        ...(req.argv ? { argv: req.argv } : {}),
        ...(req.cwd ? { cwd: req.cwd } : {}),
        ...(req.sidecar ? { sidecar: req.sidecar } : {}),
      });
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') {
        let msg: { op?: string; code?: unknown; message?: unknown };
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.op === 'opened' && !opened) { opened = true; start(); }
        else if (msg.op === 'exit') exitCode = typeof msg.code === 'number' ? msg.code : null;
        else if (msg.op === 'error') {
          if (!opened) settle({ opened: false, reason: `${String(msg.code)}: ${String(msg.message)}` });
          else stderr.write(`aura: session error: ${String(msg.message)}\n`);
        }
        return;
      }
      const b = Buffer.from(ev.data as ArrayBuffer);
      (b[0] === 2 ? stderr : stdout).write(b.subarray(1));
    };
    // A refused handshake fires `error` without a `close` (Node's WebSocket): settle on either.
    const ended = () => settle(opened ? { opened: true, code: exitCode } : { opened: false, reason: 'the shell refused the session or has no exec bridge' });
    ws.onerror = ended;
    ws.onclose = ended;
  });
}

/** One parsed SSE event of the logs route. */
export interface LogEvent { event: string; data: string }

/** Split an SSE byte stream into events (`event:` + one JSON `data:` line). */
export class SseParser {
  private buf = '';
  constructor(private readonly onEvent: (e: LogEvent) => void) {}
  push(text: string): void {
    this.buf += text;
    let i: number;
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) this.onEvent({ event, data: data.join('\n') });
    }
  }
}

export interface LogsRequest { instanceId: string; tail?: string; follow?: boolean; sidecar?: string }

/**
 * Print an instance's output through the logs route. False when the route is
 * not there or refused (the caller falls back); throws nothing.
 */
export async function printLogs(req: LogsRequest): Promise<boolean> {
  const { stdout, stderr } = process_;
  const q = new URLSearchParams();
  if (req.tail) q.set('tail', req.tail);
  if (req.follow) q.set('follow', '1');
  if (req.sidecar) q.set('sidecar', req.sidecar);
  const qs = q.toString();
  let res: Response;
  try {
    res = await shellFetch(`/api/instances/${encodeURIComponent(req.instanceId)}/logs${qs ? `?${qs}` : ''}`);
  } catch {
    return false;
  }
  if (!res.ok) { await res.body?.cancel().catch(() => undefined); return false; }
  if (!req.follow) {
    const body = await res.json() as { stdout?: string; stderr?: string };
    stdout.write(body.stdout ?? '');
    stderr.write(body.stderr ?? '');
    return true;
  }
  const parser = new SseParser(({ event, data }) => {
    let text: string;
    try { text = JSON.parse(data) as string; } catch { return; }
    if (event === 'out') stdout.write(text);
    else if (event === 'err') stderr.write(text);
    else if (event === 'error') stderr.write(`aura: ${text}\n`);
  });
  const decoder = new TextDecoder();
  const reader = res.body?.getReader();
  if (!reader) return true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  return true;
}
