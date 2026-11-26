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

export class DockerApiError extends Error {
  override readonly name = 'DockerApiError';
  constructor(readonly status: number, message: string) { super(message); }
}

export interface ExecCreateSpec {
  Cmd: string[];
  Tty: boolean;
  AttachStdin?: boolean;
  Env?: string[];
  User?: string;
  WorkingDir?: string;
}

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
  Config?: { Tty?: boolean; Env?: string[] };
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
  execStart(id: string, tty: boolean): Promise<Duplex>;
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
   * the engine's 8-byte frames, see `EngineDemux`).
   */
  execStart(id: string, tty: boolean): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ Detach: false, Tty: tty });
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
