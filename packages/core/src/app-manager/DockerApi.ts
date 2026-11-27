/**
 * The Docker Engine API over its unix socket (Phase 5 stream X): exec create,
 * start (hijacked), resize and inspect, container inspect and logs. No new
 * dependency: `node:http` speaks to the socket, and an exec's stdio is the
 * connection the daemon hands over after `101 UPGRADED`.
 *
 * The shell already holds the socket; app processes never get this client.
 * Callers that build argv or a container name do that through a runtime
 * (SandboxRunner `engineContainer`), never here (D85 A7).
 */
import http from 'node:http';
import type { Duplex, Readable } from 'node:stream';
import { DOCKER_SOCKET_PATH } from './spawn/socketArgs.js';
import { RuntimeExecError } from '../runtimes/types.js';
import type { RuntimeExecSession, RuntimeLogsRequest, RuntimeLogsStream, RuntimeOutputStream, RuntimeWorkloadExec } from '../runtimes/ari.js';

/** An engine refusal, as the neutral exec error the exec bridge maps (404 not-found, 409 not-running, else engine). */
export class DockerApiError extends RuntimeExecError {
  override readonly name = 'DockerApiError';
  constructor(readonly status: number, message: string) {
    super(status === 404 ? 'not-found' : status === 409 ? 'not-running' : 'engine', message);
  }
}

export interface ExecCreateSpec {
  Cmd: string[];
  Tty: boolean;
  AttachStdin?: boolean;
  Env?: string[];
  User?: string;
  WorkingDir?: string;
}

/** A terminal's size in character cells. */
export interface TerminalSize { cols: number; rows: number }

export interface ExecInspect {
  Running: boolean;
  ExitCode: number | null;
  /** The exec process's pid in the host's PID namespace (0 when not running). */
  Pid?: number;
}

export interface ContainerInspect {
  /** The full container id. */
  Id?: string;
  State?: { Running?: boolean; Paused?: boolean; Pid?: number };
  Config?: { Tty?: boolean; Env?: string[]; Labels?: Record<string, string> };
}

export interface LogsQuery {
  tail?: number;
  /** UNIX seconds. */
  since?: number;
  timestamps?: boolean;
  follow?: boolean;
}

/** The part of the client the exec bridge uses (tests pass a fake). */
export interface EngineClient {
  execCreate(container: string, spec: ExecCreateSpec): Promise<string>;
  /** `size`: a TTY's initial size (the engine's ConsoleSize), so the process never starts with a 0x0 terminal. */
  execStart(id: string, tty: boolean, size?: TerminalSize): Promise<Duplex>;
  execResize(id: string, cols: number, rows: number): Promise<void>;
  execInspect(id: string): Promise<ExecInspect>;
  containerInspect(container: string): Promise<ContainerInspect>;
  logs(container: string, q: LogsQuery): Promise<Readable>;
}

const MAX_JSON = 4 * 1024 * 1024;

export class DockerApi implements EngineClient {
  readonly socketPath: string;

  constructor(opts: { socketPath?: string } = {}) {
    this.socketPath = opts.socketPath ?? process.env['AURA_DOCKER_SOCKET'] ?? DOCKER_SOCKET_PATH;
  }

  /** One request; the parsed JSON body (or null), a DockerApiError on a 4xx/5xx. */
  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    const text = await readCapped(res, MAX_JSON);
    if ((res.statusCode ?? 0) >= 400) throw new DockerApiError(res.statusCode ?? 500, engineMessage(text, res.statusCode));
    return (text ? JSON.parse(text) : null) as T;
  }

  private raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({
        socketPath: this.socketPath, method, path,
        headers: { Host: 'docker', ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}), ...headers },
      }, resolve);
      req.on('error', (err) => reject(new DockerApiError(502, `docker engine unreachable: ${err.message}`)));
      req.end(payload);
    });
  }

  async execCreate(container: string, spec: ExecCreateSpec): Promise<string> {
    const r = await this.json<{ Id: string }>('POST', `/containers/${encodeURIComponent(container)}/exec`, {
      AttachStdin: spec.AttachStdin ?? true, AttachStdout: true, AttachStderr: true,
      Tty: spec.Tty, Cmd: spec.Cmd,
      ...(spec.Env ? { Env: spec.Env } : {}),
      ...(spec.User !== undefined ? { User: spec.User } : {}),
      ...(spec.WorkingDir ? { WorkingDir: spec.WorkingDir } : {}),
    });
    return r.Id;
  }

  /**
   * Start an exec and take over its connection: stdin is written to the
   * returned stream, stdout/stderr come back on it (raw with a TTY, else in
   * the engine's 8-byte frames, see `EngineDemux`). A TTY starts at `size`
   * (ConsoleSize, API 1.42+; an older engine ignores it and the caller's
   * first resize sets it): a process that reads its size at once (a session
   * launcher, `stty size`) never sees 0x0.
   */
  execStart(id: string, tty: boolean, size?: TerminalSize): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ Detach: false, Tty: tty, ...(tty && size ? { ConsoleSize: [size.rows, size.cols] } : {}) });
      const req = http.request({
        socketPath: this.socketPath, method: 'POST', path: `/exec/${encodeURIComponent(id)}/start`,
        headers: {
          Host: 'docker', 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)),
          Connection: 'Upgrade', Upgrade: 'tcp',
        },
      });
      req.on('upgrade', (_res, socket, head) => {
        if (head.length) socket.unshift(head);
        resolve(socket);
      });
      req.on('response', (res) => {
        void readCapped(res, MAX_JSON).then((text) => reject(new DockerApiError(res.statusCode ?? 500, engineMessage(text, res.statusCode))));
      });
      req.on('error', (err) => reject(new DockerApiError(502, `docker engine unreachable: ${err.message}`)));
      req.end(payload);
    });
  }

  async execResize(id: string, cols: number, rows: number): Promise<void> {
    await this.json('POST', `/exec/${encodeURIComponent(id)}/resize?h=${rows}&w=${cols}`);
  }

  async execInspect(id: string): Promise<ExecInspect> {
    const r = await this.json<{ Running?: boolean; ExitCode?: number | null; Pid?: number }>('GET', `/exec/${encodeURIComponent(id)}/json`);
    return {
      Running: r?.Running === true, ExitCode: typeof r?.ExitCode === 'number' ? r.ExitCode : null,
      ...(typeof r?.Pid === 'number' ? { Pid: r.Pid } : {}),
    };
  }

  containerInspect(container: string): Promise<ContainerInspect> {
    return this.json<ContainerInspect>('GET', `/containers/${encodeURIComponent(container)}/json`);
  }

  /** The container's output stream (raw for a TTY container, else engine frames). */
  async logs(container: string, q: LogsQuery): Promise<Readable> {
    const sp = new URLSearchParams({ stdout: '1', stderr: '1' });
    if (q.tail !== undefined) sp.set('tail', String(q.tail));
    if (q.since !== undefined) sp.set('since', String(q.since));
    if (q.timestamps) sp.set('timestamps', '1');
    if (q.follow) sp.set('follow', '1');
    const res = await this.raw('GET', `/containers/${encodeURIComponent(container)}/logs?${sp}`);
    if ((res.statusCode ?? 0) >= 400) {
      throw new DockerApiError(res.statusCode ?? 500, engineMessage(await readCapped(res, MAX_JSON), res.statusCode));
    }
    return res;
  }
}

/**
 * Splits the engine's multiplexed stream (non-TTY exec and logs): frames of
 * `[stream, 0, 0, 0, size (u32 BE)]` + payload; stream 1 is stdout, 2 stderr.
 */
export class EngineDemux {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly onFrame: (stream: 1 | 2, data: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 8) {
      const size = this.buf.readUInt32BE(4);
      if (this.buf.length < 8 + size) break;
      const stream = this.buf[0] === 2 ? 2 : 1;
      const data = this.buf.subarray(8, 8 + size);
      this.buf = this.buf.subarray(8 + size);
      if (data.length) this.onFrame(stream, data);
    }
  }
}

function readCapped(res: http.IncomingMessage, cap: number): Promise<string> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    let size = 0;
    res.on('data', (d: Buffer) => { if (size < cap) { parts.push(d); size += d.length; } });
    res.on('end', () => resolve(Buffer.concat(parts).toString('utf-8')));
    res.on('error', () => resolve(Buffer.concat(parts).toString('utf-8')));
  });
}

function engineMessage(text: string, status: number | undefined): string {
  try {
    const m = (JSON.parse(text) as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  } catch { /* not JSON */ }
  return text.trim() || `docker engine answered ${status ?? 'nothing'}`;
}

// ─── Exec and logs over the engine (the container runtime's; 5b-2 D-X) ──────
//
// Moved from ExecBridge: the session broker, the container runner's sidecar
// exec and its logs share them. The kernel's exec bridge only sees the
// `RuntimeExecSession` and `RuntimeLogsStream` they return.

const TTY_SIGNALS: Record<string, string> = { INT: '\x03', QUIT: '\x1c', TSTP: '\x1a' };
const TTY_SIGNAL = (sig: string): string | undefined => TTY_SIGNALS[String(sig).toUpperCase().replace(/^SIG/, '')];
const dimension = (v: unknown, fallback: number): number =>
  Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1000 ? v as number : fallback;

/** The exit code of an Engine exec once it finished; null if it still runs (a cut session). */
export async function engineExitCode(engine: EngineClient, id: string): Promise<number | null> {
  for (let i = 0; i < 20; i++) {
    const r = await engine.execInspect(id);
    if (!r.Running) return r.ExitCode;
    await new Promise((res) => setTimeout(res, 100));
  }
  return null;
}

/**
 * A `RuntimeExecSession` over a started Engine exec (its hijacked stream):
 * the sidecar exec and the session broker share it. `onEnd` runs once when
 * the session is closed by the caller (not when the process exits by
 * itself): the broker ends the session's processes there. The Engine API
 * cannot signal an exec process, so a signal without a TTY character ends it.
 *
 * Hand it the stream as soon as `execStart` resolves: the session ends on the
 * stream's `end`/`close`, and a process that wrote nothing ends its stream at
 * once (Node emits both on an empty stream with nobody reading). A stream
 * that already ended is taken as ended.
 */
export function engineSession(
  engine: EngineClient, id: string, sock: Duplex,
  open: { tty: boolean; cols: number; rows: number },
  onOutput: (channel: 1 | 2, data: Buffer) => void,
  opts: { onEnd?: () => void; exitCode?: () => Promise<number | null> } = {},
): RuntimeExecSession {
  const resize = (cols: number, rows: number) => {
    if (open.tty) void engine.execResize(id, dimension(cols, open.cols), dimension(rows, open.rows)).catch(() => undefined);
  };
  resize(open.cols, open.rows);
  const demux = open.tty ? null : new EngineDemux(onOutput);
  sock.on('data', (d: Buffer) => { if (demux) demux.push(d); else onOutput(1, d); });
  const exited = new Promise<number | null>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      void (opts.exitCode ?? (() => engineExitCode(engine, id)))().then(resolve, () => resolve(null));
    };
    sock.once('end', finish);
    sock.once('close', finish);
    sock.once('error', finish);
    if (sock.destroyed || sock.readableEnded) finish();
  });
  let ended = false;
  const close = () => {
    if (!ended) { ended = true; try { opts.onEnd?.(); } catch { /* best effort */ } }
    try { sock.destroy(); } catch { /* gone */ }
  };
  return {
    input: (data) => { if (sock.writable) sock.write(data); },
    endInput: () => { try { sock.end(); } catch { /* gone */ } },
    resize,
    signal: (sig) => {
      const ch = open.tty ? TTY_SIGNAL(sig) : undefined;
      if (ch && sock.writable) { sock.write(ch); return true; }
      close();
      return false;
    },
    close,
    exited,
  };
}

/** A process in a running container, as an Engine exec (a sidecar: the image's own user unless `user`). */
export async function engineExec(
  engine: EngineClient, container: string, spec: RuntimeWorkloadExec, onOutput: (channel: 1 | 2, data: Buffer) => void,
): Promise<RuntimeExecSession> {
  const id = await engine.execCreate(container, {
    Cmd: spec.argv, Tty: spec.tty,
    ...(spec.attachStdin !== undefined ? { AttachStdin: spec.attachStdin } : {}),
    Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
    ...(spec.user ? { User: spec.user } : {}),
    ...(spec.workdir ? { WorkingDir: spec.workdir } : {}),
  });
  return engineSession(engine, id, await engine.execStart(id, spec.tty, { cols: spec.cols, rows: spec.rows }), { tty: spec.tty, cols: spec.cols, rows: spec.rows }, onOutput);
}

/** A container's log (raw for a TTY container, else the engine's frames, split). */
export async function engineLogs(
  engine: EngineClient, container: string, req: RuntimeLogsRequest, onChunk: (stream: RuntimeOutputStream, data: Buffer) => void,
): Promise<RuntimeLogsStream> {
  const tty = (await engine.containerInspect(container)).Config?.Tty === true;
  const stream = await engine.logs(container, {
    ...(req.tail !== undefined ? { tail: req.tail } : {}),
    ...(req.since !== undefined ? { since: req.since } : {}),
    timestamps: req.timestamps === true, follow: req.follow === true,
  });
  const demux = tty ? null : new EngineDemux((ch, data) => onChunk(ch === 2 ? 'err' : 'out', data));
  stream.on('data', (d: Buffer) => { if (demux) demux.push(d); else onChunk('out', d); });
  const done = new Promise<void>((resolve) => {
    stream.once('end', resolve);
    stream.once('close', resolve);
    stream.once('error', () => resolve());
  });
  return { done, close: () => { try { stream.destroy(); } catch { /* gone */ } } };
}
