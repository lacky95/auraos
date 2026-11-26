/**
 * The exec bridge (Phase 5 stream X): `aura jump`, `aura exec` and
 * `aura logs` through the shell instead of a Docker socket in the caller.
 *
 *   openSession  an interactive or one-shot process in an instance's
 *                environment, its stdio streamed (WS /api/instances/:id/session,
 *                shell server/exec-bridge.mjs, subprotocol `aura.exec.v1`)
 *   run          the same, non-interactive, with capped output
 *                (POST /api/instances/:id/exec)
 *   logs         the instance's own output, optionally followed
 *                (GET /api/instances/:id/logs)
 *
 * 5-pre2 semantics (phase5-plan.md, stream X): an Engine exec into the
 * instance's existing app container as root (`User: "0"`, explicit, because
 * 5-apps containers run with `--user`), with the app's own home (its App Home). Never a
 * new container (D74). Stream J swaps the target for the in-environment
 * session broker; the transport and this API stay. Runtimes without an
 * engine container (PRoot) have no sessions here; their logs come from the
 * runner's output ring (outputLog.ts).
 *
 * Who may call is the route and surface rules' (owner, or the instance
 * itself); this module trusts its caller and never reads a credential.
 */
import type { Duplex, Readable } from 'node:stream';
import type { AccessPrincipal } from '../auth/types.js';
import type { AuditInput } from '../auth/AdminAudit.js';
import { userAttribution } from '../auth/AdminAudit.js';
import type { SidecarInfo } from '../types/instance.js';
import type { SandboxRunner } from './SandboxRunner.js';
import { DockerApiError, EngineDemux, type EngineClient } from './DockerApi.js';
import type { OutputStream } from './outputLog.js';

export const EXEC_SUBPROTOCOL = 'aura.exec.v1';

/** Binary frame channel bytes (first byte of every binary WS frame). */
export const EXEC_CHANNEL = { stdin: 0, stdout: 1, stderr: 2 } as const;

export class ExecBridgeError extends Error {
  override readonly name = 'ExecBridgeError';
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** The engine container a runtime offers for a running instance (SandboxRunner `engineContainer`). */
export interface EngineContainer {
  container: string;
  /** The app's directory inside the container: the default working directory. */
  workdir?: string;
  /** Always set for a session (today's `docker exec` set them too). */
  env?: Record<string, string>;
}

/** The validated first frame of a session. */
export interface SessionOpen {
  kind: 'jump' | 'exec';
  argv?: string[];
  tty: boolean;
  cols: number;
  rows: number;
  cwd?: string;
  env: Record<string, string>;
  /** Owner only (the route decides): a sidecar of the instance, as its image user. */
  sidecar?: string;
}

export interface ExecSession {
  input(data: Buffer): void;
  /** Close the process's stdin (non-TTY: EOF). */
  endInput(): void;
  resize(cols: number, rows: number): void;
  /**
   * A signal for the process. With a TTY, INT, QUIT and TSTP go in as the
   * terminal's control characters; anything else (and every signal without a
   * TTY) ends the session: the Engine API cannot signal an exec process.
   * Returns false when the session was ended instead.
   */
  signal(sig: string): boolean;
  close(): void;
  /** The exit code; null when it could not be read (the session was cut). */
  readonly exited: Promise<number | null>;
}

export interface RunRequest {
  cmd: string[];
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface LogsRequest {
  tail?: number;
  since?: number;
  timestamps?: boolean;
  follow?: boolean;
  sidecar?: string;
}

export interface LogsStream {
  /** Resolves when the output ends (never, while following, until `close`). */
  done: Promise<void>;
  close(): void;
}

interface InstanceLike { appId: string; instanceId: string; state?: string }

export interface ExecBridgeDeps {
  engine: EngineClient;
  instance(instanceId: string): InstanceLike | undefined;
  runner(instanceId: string): Pick<SandboxRunner, 'isRunning' | 'engineContainer' | 'outputLog'>;
  sidecars(instanceId: string): SidecarInfo[];
}

const MAX_ARGV = 1024;
const MAX_ARGV_BYTES = 256 * 1024;
const MAX_STDIN = 64 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_TAIL = 5000;
const SESSION_ENV = ['TERM', 'COLORTERM', 'LANG', 'LC_ALL'] as const;
const ENV_VALUE = /^[A-Za-z0-9_.:@+-]{0,64}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** An interactive jump without argv: bash if the image has it, else sh. */
export const DEFAULT_JUMP_ARGV = ['sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash -i || exec sh -i'];
const TTY_SIGNALS: Record<string, string> = { INT: '\x03', QUIT: '\x1c', TSTP: '\x1a' };

const bad = (message: string) => new ExecBridgeError(400, 'bad-request', message);

function checkArgv(argv: unknown, what: string): string[] {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV
    || !argv.every((a) => typeof a === 'string' && !a.includes('\0'))) {
    throw bad(`${what} must be a non-empty array of strings`);
  }
  if (argv.reduce((n, a: string) => n + Buffer.byteLength(a), 0) > MAX_ARGV_BYTES) throw bad(`${what} is limited to 256 KiB`);
  return argv as string[];
}

const dimension = (v: unknown, fallback: number): number =>
  Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1000 ? v as number : fallback;

/**
 * Validate a session's first frame (`{op:'open', …}`). `home` is J's (D74):
 * until then a session sees the app's own App Home, so asking for one is refused
 * rather than silently ignored.
 */
export function parseSessionOpen(frame: unknown): SessionOpen {
  if (!frame || typeof frame !== 'object' || (frame as { op?: unknown }).op !== 'open') throw bad('the first frame must be {op:"open", …}');
  const f = frame as Record<string, unknown>;
  if (f['kind'] !== 'jump' && f['kind'] !== 'exec') throw bad('kind must be jump or exec');
  if (f['home'] !== undefined) {
    throw new ExecBridgeError(409, 'capability-missing', 'home modes come with the in-environment session (privateHomeSession); this release enters with the app\'s own App Home');
  }
  const argv = f['argv'] === undefined ? undefined : checkArgv(f['argv'], 'argv');
  if (f['kind'] === 'exec' && !argv) throw bad('exec needs argv');
  if (f['cwd'] !== undefined && (typeof f['cwd'] !== 'string' || !f['cwd'].startsWith('/') || f['cwd'].includes('\0') || f['cwd'].length > 4096)) {
    throw bad('cwd must be an absolute path');
  }
  if (f['sidecar'] !== undefined && (typeof f['sidecar'] !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(f['sidecar']))) throw bad('bad sidecar name');
  const env: Record<string, string> = {};
  const rawEnv = (f['env'] && typeof f['env'] === 'object' ? f['env'] : {}) as Record<string, unknown>;
  for (const key of SESSION_ENV) {
    const v = rawEnv[key];
    if (typeof v === 'string' && ENV_VALUE.test(v)) env[key] = v;
  }
  return {
    kind: f['kind'], tty: f['tty'] === true,
    cols: dimension(f['cols'], 80), rows: dimension(f['rows'], 24),
    env,
    ...(argv ? { argv } : {}),
    ...(typeof f['cwd'] === 'string' ? { cwd: f['cwd'] } : {}),
    ...(typeof f['sidecar'] === 'string' ? { sidecar: f['sidecar'] } : {}),
  };
}

/**
 * A logs `since`: UNIX seconds, an RFC 3339 time, or a duration back from
 * now (`90s`, `10m`, `2h`, `1d`). Undefined for an empty value.
 */
export function parseSince(raw: string | null | undefined, now = Date.now()): number | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const d = /^(\d+)(s|m|h|d)$/.exec(raw);
  if (d) return Math.floor(now / 1000) - Number(d[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[d[2] as 's' | 'm' | 'h' | 'd'];
  const t = Date.parse(raw);
  if (Number.isFinite(t)) return Math.floor(t / 1000);
  throw bad('since must be UNIX seconds, an RFC 3339 time or a duration like 10m');
}

export function parseTail(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw === '' || raw === 'all') return undefined;
  if (!/^\d+$/.test(raw)) throw bad('tail must be a number of lines');
  return Math.min(Math.max(Number(raw), 0), MAX_TAIL);
}

function engineError(err: unknown): ExecBridgeError {
  if (err instanceof ExecBridgeError) return err;
  if (err instanceof DockerApiError) {
    if (err.status === 404) return new ExecBridgeError(404, 'not-found', err.message);
    if (err.status === 409) return new ExecBridgeError(409, 'not-running', err.message);
    return new ExecBridgeError(502, 'engine', err.message);
  }
  return new ExecBridgeError(500, 'internal', err instanceof Error ? err.message : String(err));
}

interface Target extends EngineContainer { user?: string; label: string }

export class ExecBridge {
  constructor(private readonly deps: ExecBridgeDeps) {}

  /** The engine container a session or exec enters: the app's own, or one of its sidecars. */
  private target(instanceId: string, sidecar?: string): Target {
    const inst = this.deps.instance(instanceId);
    if (!inst) throw new ExecBridgeError(404, 'not-found', `Instance not found: ${instanceId}`);
    if (sidecar) {
      const sc = this.deps.sidecars(instanceId).find((s) => s.service === sidecar || s.id === sidecar);
      if (!sc) throw new ExecBridgeError(404, 'not-found', `no sidecar '${sidecar}' in ${instanceId}`);
      if (sc.backend !== 'container') throw new ExecBridgeError(409, 'runtime-unsupported', `sidecar ${sc.id} has no engine container`);
      if (sc.state !== 'running') throw new ExecBridgeError(409, 'not-running', `sidecar ${sc.id} is ${sc.state}`);
      // The image's own user: sidecars run foreign images.
      return { container: sc.id, label: `${instanceId}/${sc.service}` };
    }
    const runner = this.deps.runner(instanceId);
    if (!runner.isRunning(instanceId)) throw new ExecBridgeError(409, 'not-running', `${instanceId} is not running`);
    const engine = runner.engineContainer?.(instanceId) ?? null;
    if (!engine) {
      throw new ExecBridgeError(409, 'runtime-unsupported', `${instanceId} runs in a runtime without an engine container; the exec bridge cannot enter it`);
    }
    return { ...engine, env: { AURA_HOSTNAME: inst.appId, ...engine.env }, user: '0', label: instanceId };
  }

  async openSession(instanceId: string, open: SessionOpen, onOutput: (channel: 1 | 2, data: Buffer) => void): Promise<ExecSession> {
    const t = this.target(instanceId, open.sidecar);
    const argv = open.argv ?? DEFAULT_JUMP_ARGV;
    const env = Object.entries({ ...t.env, ...open.env }).map(([k, v]) => `${k}=${v}`);
    const { engine } = this.deps;
    let id: string;
    let sock: Duplex;
    try {
      id = await engine.execCreate(t.container, {
        Cmd: argv, Tty: open.tty, Env: env,
        ...(t.user !== undefined ? { User: t.user } : {}),
        ...(open.cwd ?? t.workdir ? { WorkingDir: open.cwd ?? t.workdir } : {}),
      });
      sock = await engine.execStart(id, open.tty);
    } catch (err) {
      throw engineError(err);
    }
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
        void this.exitCode(id).then(resolve, () => resolve(null));
      };
      sock.once('end', finish);
      sock.once('close', finish);
      sock.once('error', finish);
    });
    const close = () => { try { sock.destroy(); } catch { /* gone */ } };
    return {
      input: (data) => { if (sock.writable) sock.write(data); },
      endInput: () => { try { sock.end(); } catch { /* gone */ } },
      resize,
      signal: (sig) => {
        const ch = open.tty ? TTY_SIGNALS[String(sig).toUpperCase().replace(/^SIG/, '')] : undefined;
        if (ch && sock.writable) { sock.write(ch); return true; }
        close();
        return false;
      },
      close,
      exited,
    };
  }

  /** The exec's exit code once the engine reports it finished; null if it still runs (a cut session). */
  private async exitCode(id: string): Promise<number | null> {
    for (let i = 0; i < 20; i++) {
      const r = await this.deps.engine.execInspect(id);
      if (!r.Running) return r.ExitCode;
      await new Promise((res) => setTimeout(res, 100));
    }
    return null;
  }

  /**
   * A non-interactive command, as the sidecar exec contract
   * (`sidecars/[name]/exec.ts`): argv only, stdin ≤ 64 KiB, output capped at
   * 4 MiB per stream, default timeout 30 s (max 10 min). A timeout cuts the
   * connection; the Engine API cannot kill the process.
   */
  async run(instanceId: string, req: RunRequest, opts: { sidecar?: string } = {}): Promise<RunResult> {
    const cmd = checkArgv(req?.cmd, 'cmd');
    if (req.stdin !== undefined && (typeof req.stdin !== 'string' || Buffer.byteLength(req.stdin) > MAX_STDIN)) {
      throw new ExecBridgeError(413, 'too-large', 'stdin is limited to 64 KiB');
    }
    if (req.workdir !== undefined && (typeof req.workdir !== 'string' || !req.workdir.startsWith('/'))) throw bad('workdir must be an absolute path');
    if (req.user !== undefined && (typeof req.user !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(req.user))) throw bad('bad user');
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.env ?? {})) {
      if (!ENV_KEY.test(k) || typeof v !== 'string' || v.includes('\0')) throw bad(`bad env ${k}`);
      env[k] = v;
    }
    const timeoutMs = Math.min(Math.max(Number(req.timeoutMs) || 30_000, 1_000), 10 * 60_000);
    const t = this.target(instanceId, opts.sidecar);
    const { engine } = this.deps;
    let id: string;
    let sock: Duplex;
    try {
      id = await engine.execCreate(t.container, {
        Cmd: cmd, Tty: false, AttachStdin: req.stdin !== undefined,
        Env: Object.entries({ ...t.env, ...env }).map(([k, v]) => `${k}=${v}`),
        ...(req.user ?? t.user ? { User: req.user ?? t.user } : {}),
        ...(req.workdir ?? t.workdir ? { WorkingDir: req.workdir ?? t.workdir } : {}),
      });
      sock = await engine.execStart(id, false);
    } catch (err) {
      throw engineError(err);
    }
    const out = { 1: [] as Buffer[], 2: [] as Buffer[] };
    const size = { 1: 0, 2: 0 };
    let truncated = false;
    const demux = new EngineDemux((ch, data) => {
      const room = MAX_OUTPUT - size[ch];
      if (room <= 0) { truncated = true; return; }
      if (data.length > room) { truncated = true; data = data.subarray(0, room); }
      out[ch].push(data);
      size[ch] += data.length;
    });
    sock.on('data', (d: Buffer) => demux.push(d));
    let timedOut = false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { timedOut = true; sock.destroy(); }, timeoutMs);
      const done = () => { clearTimeout(timer); resolve(); };
      sock.once('close', done);
      sock.once('end', done);
      sock.once('error', done);
      if (req.stdin !== undefined) sock.end(req.stdin);
    });
    const exitCode = timedOut ? null : await this.exitCode(id).catch(() => null);
    return {
      exitCode,
      stdout: Buffer.concat(out[1]).toString('utf-8'),
      stderr: Buffer.concat(out[2]).toString('utf-8'),
      truncated, timedOut,
    };
  }

  /**
   * The instance's own output (or a sidecar's): the engine's log for a
   * container, the runner's output ring otherwise. `onChunk` gets each piece
   * as it comes; with `follow` it keeps coming until `close`.
   */
  async logs(instanceId: string, req: LogsRequest, onChunk: (stream: OutputStream, data: Buffer) => void): Promise<LogsStream> {
    const inst = this.deps.instance(instanceId);
    if (!inst) throw new ExecBridgeError(404, 'not-found', `Instance not found: ${instanceId}`);
    const tail = req.tail !== undefined ? Math.min(Math.max(Math.floor(req.tail), 0), MAX_TAIL) : undefined;
    let container: string | null = null;
    if (req.sidecar) {
      const sc = this.deps.sidecars(instanceId).find((s) => s.service === req.sidecar || s.id === req.sidecar);
      if (!sc) throw new ExecBridgeError(404, 'not-found', `no sidecar '${req.sidecar}' in ${instanceId}`);
      if (sc.backend !== 'container') throw new ExecBridgeError(409, 'runtime-unsupported', `sidecar ${sc.id} has no engine log`);
      container = sc.id;
    } else {
      const runner = this.deps.runner(instanceId);
      container = runner.engineContainer?.(instanceId)?.container ?? null;
      if (!container) {
        const log = runner.outputLog?.(instanceId) ?? null;
        if (!log) throw new ExecBridgeError(409, 'runtime-unsupported', `${instanceId} keeps no output log`);
        for (const c of log.read({ ...(tail !== undefined ? { tail } : {}), ...(req.since !== undefined ? { since: req.since } : {}), timestamps: req.timestamps === true })) {
          onChunk(c.stream, Buffer.from(c.data));
        }
        if (!req.follow) return { done: Promise.resolve(), close: () => undefined };
        let stop = () => {};
        const done = new Promise<void>((resolve) => {
          const unfollow = log.follow((c) => onChunk(c.stream, Buffer.from(c.data)), { timestamps: req.timestamps === true });
          stop = () => { unfollow(); resolve(); };
        });
        return { done, close: () => stop() };
      }
    }
    const { engine } = this.deps;
    let stream: Readable;
    let tty = false;
    try {
      tty = (await engine.containerInspect(container)).Config?.Tty === true;
      stream = await engine.logs(container, {
        ...(tail !== undefined ? { tail } : {}),
        ...(req.since !== undefined ? { since: req.since } : {}),
        timestamps: req.timestamps === true, follow: req.follow === true,
      });
    } catch (err) {
      throw engineError(err);
    }
    const demux = tty ? null : new EngineDemux((ch, data) => onChunk(ch === 2 ? 'err' : 'out', data));
    stream.on('data', (d: Buffer) => { if (demux) demux.push(d); else onChunk('out', d); });
    const done = new Promise<void>((resolve) => {
      stream.once('end', resolve);
      stream.once('close', resolve);
      stream.once('error', () => resolve());
    });
    return { done, close: () => { try { stream.destroy(); } catch { /* gone */ } } };
  }
}

/**
 * The audit entry of a session or exec, attributed to the verified
 * principal's user (never a header): the owner's login, the user an instance
 * acts for (its token's `u` claim), or the host operator.
 */
export function execAudit(
  principal: AccessPrincipal | null | undefined,
  action: 'session.opened' | 'session.closed' | 'instance.exec' | 'instance.logs',
  target: { appId?: string | undefined; instanceId: string },
  detail: Record<string, unknown> = {},
  outcome: AuditInput['outcome'] = 'ok',
): AuditInput {
  let by: AuditInput['by'] = { kind: 'anonymous' };
  const via: Record<string, unknown> = {};
  if (principal?.kind === 'operator') by = { kind: 'operator' };
  else if (principal?.kind === 'user') by = userAttribution(principal);
  else if (principal?.kind === 'instance') {
    via['through'] = { appId: principal.appId, instanceId: principal.instanceId, ...(principal.sidecar ? { sidecar: principal.sidecar } : {}) };
    by = principal.userId ? { kind: 'user', userId: principal.userId } : { kind: 'system' };
  }
  return {
    by, action, outcome,
    target: target.appId ? `app:${target.appId}` : `instance:${target.instanceId}`,
    detail: { instance: target.instanceId, ...via, ...detail },
  };
}
