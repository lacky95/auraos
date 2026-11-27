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
 * Sessions (stream J, D74, phase5-plan.md J.2–J.5): a session enters the
 * instance's RUNNING environment through its runtime (`SandboxRunner
 * openSession`; the container runtime's session broker), never a new
 * container. Only its mount namespace, identity and home differ:
 *   --home private (default)  the user's uid/gid and Private Home
 *   --home ephemeral          the user's uid/gid and a tmpfs home
 *   --home app                the app's uid/gid and its App Home (D79)
 * The kernel decides everything (`sessionContext`: the Home Resolver, the
 * installation's runAs, the user's identity); the runtime only executes the
 * spec. Gated on the instance runtime's `sessionExec`/`privateHomeSession`
 * and, for private and ephemeral, a non-root target (J.5): a miss refuses
 * (`capability-missing`), nothing falls back. A caller without a human user
 * (the instance itself) gets only `app`. Runtimes without sessions (PRoot)
 * refuse every mode; their logs come from the runner's output ring
 * (outputLog.ts).
 *
 * A sidecar target stays an owner-only exec in the actual sidecar with its
 * image user, never with a Private Home (J.4), through its runtime's
 * `workloads.exec`; logs come from the runtime's `logs` (5b-2 D-X). This
 * module holds no engine client: it only validates, gates and streams.
 *
 * Who may call is the route and surface rules' (owner, or the instance
 * itself, or a member with `app.jump`); this module trusts the caller it is
 * handed and never reads a credential.
 */
import { randomUUID } from 'node:crypto';
import type { AccessPrincipal } from '../auth/types.js';
import { homeRequirements } from '../homes/HomeResolver.js';
import { HomeDeniedError, type JumpHomeMode } from '../homes/types.js';
import { RuntimeCapabilityError, RuntimeExecError, missingCapabilities } from '../runtimes/types.js';
import { isRootGrantToken } from './rootTabs.js';
import type { AuditInput } from '../auth/AdminAudit.js';
import { userAttribution } from '../auth/AdminAudit.js';
import type { SidecarInfo } from '../types/instance.js';
import type { SandboxRunner } from './SandboxRunner.js';
import type { OutputStream } from './outputLog.js';
import type { RuntimeExecSession, RuntimeLogs, RuntimeWorkloads, SessionSpec } from '../runtimes/ari.js';

export const EXEC_SUBPROTOCOL = 'aura.exec.v1';

/** Binary frame channel bytes (first byte of every binary WS frame). */
export const EXEC_CHANNEL = { stdin: 0, stdout: 1, stderr: 2 } as const;

export class ExecBridgeError extends Error {
  override readonly name = 'ExecBridgeError';
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/**
 * One in-environment session as the kernel decided it (D74, ARI §9.6): what a
 * runtime's `openSession` executes. The ARI contract shape (runtimes/ari.ts);
 * built only by the kernel from the verified caller and the session record;
 * nothing in it comes from the client except argv, cwd, the terminal size and
 * the TERM/LANG env.
 */
export type { SessionSpec };

/** The kernel's part of a session spec (AppManager `sessionContext`). */
export type SessionContext = Omit<SessionSpec, 'sessionId' | 'instanceId' | 'argv' | 'tty' | 'cols' | 'rows'>;

/** Who a session is for, as the shell verified it. */
export interface SessionCaller {
  /** The human user (D84: Private Homes are human-only). Absent: the instance itself, which gets `app` only. */
  user?: { userId: string; role: 'owner' | 'member' };
  /** A root tab: the shell checked an approved, live root grant for this user and instance (J.6). */
  root?: boolean;
}

/** The validated first frame of a session. */
export interface SessionOpen {
  kind: 'jump' | 'exec';
  /** `aura jump --home` (D67); default `private` for a user, `app` for the instance itself. */
  home?: JumpHomeMode;
  argv?: string[];
  tty: boolean;
  cols: number;
  rows: number;
  cwd?: string;
  env: Record<string, string>;
  /** Owner only (the route decides): a sidecar of the instance, as its image user. */
  sidecar?: string;
  /** A root tab (J.6): the single-use grant `POST /api/admin/root` issued; the shell consumes it. */
  root?: string;
}

/** A session's process, its stdio streamed (the ARI shape). */
export type ExecSession = RuntimeExecSession;

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
  instance(instanceId: string): InstanceLike | undefined;
  runner(instanceId: string): Pick<SandboxRunner, 'isRunning' | 'outputLog' | 'openSession' | 'capabilities'>;
  /** The instance runtime's `logs` (absent: the runner's output ring, if it keeps one). */
  logs(instanceId: string): RuntimeLogs | undefined;
  /** The instance runtime's associated workloads (absent: the runtime has none). */
  workloads(instanceId: string): Pick<RuntimeWorkloads, 'exec' | 'logs'> | undefined;
  sidecars(instanceId: string): SidecarInfo[];
  /** The kernel's decision for a session (identity, home, env): throws HomeDeniedError / RuntimeCapabilityError. */
  sessionContext(instanceId: string, req: { mode: JumpHomeMode; caller: SessionCaller }): Promise<SessionContext>;
}

const MAX_ARGV = 1024;
const MAX_ARGV_BYTES = 256 * 1024;
const MAX_STDIN = 64 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_TAIL = 5000;
const SESSION_ENV = ['TERM', 'COLORTERM', 'LANG', 'LC_ALL'] as const;
const ENV_VALUE = /^[A-Za-z0-9_.:@+-]{0,64}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Keys a caller never sets in a session: the kernel's. */
const RESERVED_ENV = new Set(['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'AURA_SESSION', 'PATH', 'SHELL']);
const HOME_MODES: readonly JumpHomeMode[] = ['private', 'app', 'ephemeral'];
/** An interactive jump without argv: bash if the image has it, else sh. */
export const DEFAULT_JUMP_ARGV = ['sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash -i || exec sh -i'];

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

/** Validate a session's first frame (`{op:'open', …}`). */
export function parseSessionOpen(frame: unknown): SessionOpen {
  if (!frame || typeof frame !== 'object' || (frame as { op?: unknown }).op !== 'open') throw bad('the first frame must be {op:"open", …}');
  const f = frame as Record<string, unknown>;
  if (f['kind'] !== 'jump' && f['kind'] !== 'exec') throw bad('kind must be jump or exec');
  if (f['home'] !== undefined && !HOME_MODES.includes(f['home'] as JumpHomeMode)) throw bad('home must be private, app or ephemeral');
  const argv = f['argv'] === undefined ? undefined : checkArgv(f['argv'], 'argv');
  if (f['kind'] === 'exec' && !argv) throw bad('exec needs argv');
  if (f['cwd'] !== undefined && (typeof f['cwd'] !== 'string' || !f['cwd'].startsWith('/') || f['cwd'].includes('\0') || f['cwd'].length > 4096)) {
    throw bad('cwd must be an absolute path');
  }
  if (f['sidecar'] !== undefined && (typeof f['sidecar'] !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(f['sidecar']))) throw bad('bad sidecar name');
  if (f['sidecar'] !== undefined && f['home'] !== undefined) throw bad('a sidecar session has the image\'s own user and home');
  if (f['root'] !== undefined && (!isRootGrantToken(f['root']) || f['sidecar'] !== undefined || (f['home'] !== undefined && f['home'] !== 'private'))) {
    throw bad('root: a root grant, into the instance itself, with the Private Home');
  }
  const env: Record<string, string> = {};
  const rawEnv = (f['env'] && typeof f['env'] === 'object' ? f['env'] : {}) as Record<string, unknown>;
  for (const key of SESSION_ENV) {
    const v = rawEnv[key];
    if (typeof v === 'string' && ENV_VALUE.test(v)) env[key] = v;
  }
  return {
    kind: f['kind'], tty: f['tty'] === true,
    ...(f['home'] !== undefined ? { home: f['home'] as JumpHomeMode } : {}),
    cols: dimension(f['cols'], 80), rows: dimension(f['rows'], 24),
    env,
    ...(argv ? { argv } : {}),
    ...(typeof f['cwd'] === 'string' ? { cwd: f['cwd'] } : {}),
    ...(typeof f['sidecar'] === 'string' ? { sidecar: f['sidecar'] } : {}),
    ...(typeof f['root'] === 'string' ? { root: f['root'] } : {}),
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

export function engineError(err: unknown): ExecBridgeError {
  if (err instanceof ExecBridgeError) return err;
  if (err instanceof RuntimeCapabilityError) return new ExecBridgeError(409, 'capability-missing', err.message);
  if (err instanceof HomeDeniedError) {
    if (err.reason === 'not-authorized') return new ExecBridgeError(403, 'forbidden', err.message);
    if (err.reason === 'root-instance') {
      return new ExecBridgeError(409, 'capability-missing', `capability-missing: identity (instance runs as root, see the P5-3 report: aura admin apps privileges): ${err.message}`);
    }
    return new ExecBridgeError(409, 'home-denied', err.message);
  }
  if (err instanceof RuntimeExecError) {
    if (err.code === 'not-found') return new ExecBridgeError(404, 'not-found', err.message);
    if (err.code === 'not-running') return new ExecBridgeError(409, 'not-running', err.message);
    return new ExecBridgeError(502, 'engine', err.message);
  }
  return new ExecBridgeError(500, 'internal', err instanceof Error ? err.message : String(err));
}

interface SidecarTarget { workload: string; label: string }

export class ExecBridge {
  constructor(private readonly deps: ExecBridgeDeps) {}

  /** A sidecar of the instance: its workload, entered with the image's own user. */
  private sidecarTarget(instanceId: string, sidecar: string): SidecarTarget {
    const sc = this.deps.sidecars(instanceId).find((s) => s.service === sidecar || s.id === sidecar);
    if (!sc) throw new ExecBridgeError(404, 'not-found', `no sidecar '${sidecar}' in ${instanceId}`);
    if (sc.backend !== 'container') throw new ExecBridgeError(409, 'runtime-unsupported', `sidecar ${sc.id} has no engine container`);
    if (sc.state !== 'running') throw new ExecBridgeError(409, 'not-running', `sidecar ${sc.id} is ${sc.state}`);
    return { workload: sc.id, label: `${instanceId}/${sc.service}` };
  }

  /** The runtime's workload exec of an instance; a runtime without associated workloads has no sidecar to enter. */
  private workloadExec(instanceId: string): RuntimeWorkloads['exec'] {
    const w = this.deps.workloads(instanceId);
    if (!w) throw new ExecBridgeError(409, 'runtime-unsupported', `${instanceId}'s runtime has no associated workloads`);
    return w.exec;
  }

  private instanceOf(instanceId: string): InstanceLike {
    const inst = this.deps.instance(instanceId);
    if (!inst) throw new ExecBridgeError(404, 'not-found', `Instance not found: ${instanceId}`);
    return inst;
  }

  /**
   * The session spec of a jump or exec into the instance's own environment:
   * the runtime's capabilities first (J.5), then the kernel's decision.
   */
  async sessionSpec(instanceId: string, open: SessionOpen, caller: SessionCaller): Promise<SessionSpec> {
    this.instanceOf(instanceId);
    const runner = this.deps.runner(instanceId);
    if (!runner.isRunning(instanceId)) throw new ExecBridgeError(409, 'not-running', `${instanceId} is not running`);
    const mode: JumpHomeMode = open.home ?? (caller.user ? 'private' : 'app');
    if (!caller.user && (mode !== 'app' || caller.root)) {
      throw new ExecBridgeError(403, 'forbidden', 'a session without a human user runs as the app only (--home app)');
    }
    if (caller.root && mode !== 'private') throw new ExecBridgeError(400, 'bad-request', 'a root tab has the user\'s Private Home');
    const missing = missingCapabilities(runner.capabilities(), homeRequirements({ executionContext: 'jump', jumpHomeMode: mode }).capabilities);
    if (missing.length || !runner.openSession) {
      throw new ExecBridgeError(409, 'capability-missing',
        `capability-missing: ${(missing.length ? missing : ['sessionExec']).join(', ')} (this runtime can't open a ${mode} session inside the running app; no weaker mapping is used)`);
    }
    let ctx: SessionContext;
    try {
      ctx = await this.deps.sessionContext(instanceId, { mode, caller });
    } catch (err) {
      throw engineError(err);
    }
    const env = { ...ctx.env };
    for (const [k, v] of Object.entries(open.env)) if (!RESERVED_ENV.has(k)) env[k] = v;
    const cwd = open.cwd ?? ctx.cwd;
    const sessionId = randomUUID();
    env['AURA_SESSION'] = sessionId;
    return {
      ...ctx, env, sessionId, instanceId,
      argv: open.argv ?? DEFAULT_JUMP_ARGV, tty: open.tty, cols: open.cols, rows: open.rows,
      ...(cwd ? { cwd } : {}),
    };
  }

  async openSession(
    instanceId: string, open: SessionOpen, onOutput: (channel: 1 | 2, data: Buffer) => void, caller: SessionCaller = {},
  ): Promise<ExecSession> {
    this.instanceOf(instanceId);
    if (open.sidecar) {
      const t = this.sidecarTarget(instanceId, open.sidecar);
      const exec = this.workloadExec(instanceId);
      try {
        return await exec(t.workload, {
          argv: open.argv ?? DEFAULT_JUMP_ARGV, tty: open.tty, env: open.env, cols: open.cols, rows: open.rows,
          ...(open.cwd ? { workdir: open.cwd } : {}),
        }, onOutput);
      } catch (err) {
        throw engineError(err);
      }
    }
    const spec = await this.sessionSpec(instanceId, open, caller);
    try {
      return await this.deps.runner(instanceId).openSession!(instanceId, spec, onOutput);
    } catch (err) {
      throw engineError(err);
    }
  }

  /**
   * A non-interactive command, as the sidecar exec contract
   * (`sidecars/[name]/exec.ts`): argv only, stdin ≤ 64 KiB, output capped at
   * 4 MiB per stream, default timeout 30 s (max 10 min). Into the instance it
   * is a non-interactive session (`aura exec` = a jump without a TTY, J.4):
   * the same identity and home rules; `user` is a sidecar's only. A timeout
   * ends the session.
   */
  async run(instanceId: string, req: RunRequest, opts: { sidecar?: string; caller?: SessionCaller; home?: JumpHomeMode } = {}): Promise<RunResult> {
    const cmd = checkArgv(req?.cmd, 'cmd');
    if (req.stdin !== undefined && (typeof req.stdin !== 'string' || Buffer.byteLength(req.stdin) > MAX_STDIN)) {
      throw new ExecBridgeError(413, 'too-large', 'stdin is limited to 64 KiB');
    }
    if (req.workdir !== undefined && (typeof req.workdir !== 'string' || !req.workdir.startsWith('/'))) throw bad('workdir must be an absolute path');
    if (req.user !== undefined && (typeof req.user !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(req.user))) throw bad('bad user');
    if (req.user !== undefined && !opts.sidecar) throw bad('user: a session\'s identity follows its home mode (--home); user is for a sidecar only');
    if (opts.home !== undefined && !HOME_MODES.includes(opts.home)) throw bad('home must be private, app or ephemeral');
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.env ?? {})) {
      if (!ENV_KEY.test(k) || typeof v !== 'string' || v.includes('\0')) throw bad(`bad env ${k}`);
      env[k] = v;
    }
    const timeoutMs = Math.min(Math.max(Number(req.timeoutMs) || 30_000, 1_000), 10 * 60_000);
    this.instanceOf(instanceId);
    const out = { 1: [] as Buffer[], 2: [] as Buffer[] };
    const size = { 1: 0, 2: 0 };
    let truncated = false;
    const collect = (ch: 1 | 2, data: Buffer) => {
      const room = MAX_OUTPUT - size[ch];
      if (room <= 0) { truncated = true; return; }
      if (data.length > room) { truncated = true; data = data.subarray(0, room); }
      out[ch].push(data);
      size[ch] += data.length;
    };
    let session: ExecSession;
    if (opts.sidecar) {
      const t = this.sidecarTarget(instanceId, opts.sidecar);
      const exec = this.workloadExec(instanceId);
      try {
        session = await exec(t.workload, {
          argv: cmd, tty: false, attachStdin: req.stdin !== undefined, env, cols: 80, rows: 24,
          ...(req.user ? { user: req.user } : {}),
          ...(req.workdir ? { workdir: req.workdir } : {}),
        }, collect);
      } catch (err) {
        throw engineError(err);
      }
    } else {
      const open: SessionOpen = {
        kind: 'exec', argv: cmd, tty: false, cols: 80, rows: 24, env,
        ...(opts.home ? { home: opts.home } : {}), ...(req.workdir ? { cwd: req.workdir } : {}),
      };
      session = await this.openSession(instanceId, open, collect, opts.caller ?? {});
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; session.close(); }, timeoutMs);
    if (req.stdin !== undefined) session.input(Buffer.from(req.stdin));
    // A session's stdin is always attached: EOF so a command that reads it ends.
    if (req.stdin !== undefined || !opts.sidecar) session.endInput();
    const code = await session.exited;
    clearTimeout(timer);
    return {
      exitCode: timedOut ? null : code,
      stdout: Buffer.concat(out[1]).toString('utf-8'),
      stderr: Buffer.concat(out[2]).toString('utf-8'),
      truncated, timedOut,
    };
  }

  /**
   * The instance's own output (or a sidecar's): the runtime's log for a
   * container, the runner's output ring otherwise. `onChunk` gets each piece
   * as it comes; with `follow` it keeps coming until `close`.
   */
  async logs(instanceId: string, req: LogsRequest, onChunk: (stream: OutputStream, data: Buffer) => void): Promise<LogsStream> {
    const inst = this.deps.instance(instanceId);
    if (!inst) throw new ExecBridgeError(404, 'not-found', `Instance not found: ${instanceId}`);
    const tail = req.tail !== undefined ? Math.min(Math.max(Math.floor(req.tail), 0), MAX_TAIL) : undefined;
    const q = {
      ...(tail !== undefined ? { tail } : {}),
      ...(req.since !== undefined ? { since: req.since } : {}),
      timestamps: req.timestamps === true, follow: req.follow === true,
    };
    let read: () => ReturnType<RuntimeLogs>;
    if (req.sidecar) {
      const sc = this.deps.sidecars(instanceId).find((s) => s.service === req.sidecar || s.id === req.sidecar);
      if (!sc) throw new ExecBridgeError(404, 'not-found', `no sidecar '${req.sidecar}' in ${instanceId}`);
      const w = this.deps.workloads(instanceId);
      if (sc.backend !== 'container' || !w) throw new ExecBridgeError(409, 'runtime-unsupported', `sidecar ${sc.id} has no engine log`);
      read = () => w.logs(sc.id, q, onChunk);
    } else {
      const logs = this.deps.logs(instanceId);
      if (!logs) {
        const log = this.deps.runner(instanceId).outputLog?.(instanceId) ?? null;
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
      read = () => logs(instanceId, q, onChunk);
    }
    try {
      return await read();
    } catch (err) {
      throw engineError(err);
    }
  }
}

/**
 * The session caller of a verified principal, by the level the shell's rule
 * let it in at: `owner` (the owner's login, the host operator, or a trusted
 * owner agent acting for the owner, D29), `member` (a member's own login, or
 * a member's own System Terminal acting for it by its token's `u`, D69; its
 * `app.jump` grant is the kernel's check), `self` (the instance itself: the
 * app identity only). Never from a header or the open frame.
 */
export function sessionCallerOf(principal: AccessPrincipal | null | undefined, level: 'owner' | 'member' | 'self', ownerId: string): SessionCaller {
  if (level === 'self') return {};
  if (principal?.kind === 'operator') return { user: { userId: ownerId, role: 'owner' } };
  if (principal?.kind === 'user') {
    if (level === 'owner' && principal.role !== 'owner') return {};
    return { user: { userId: principal.userId, role: principal.role } };
  }
  if (principal?.kind === 'instance' && level === 'owner') return { user: { userId: principal.userId ?? ownerId, role: 'owner' } };
  if (principal?.kind === 'instance' && level === 'member' && !principal.sidecar && principal.userId) return { user: { userId: principal.userId, role: 'member' } };
  return {};
}

/**
 * The audit entry of a session or exec, attributed to the verified
 * principal's user (never a header): the owner's login, the user an instance
 * acts for (its token's `u` claim), or the host operator.
 */
export function execAudit(
  principal: AccessPrincipal | null | undefined,
  action: 'session.opened' | 'session.closed' | 'instance.exec' | 'instance.logs' | 'root.granted' | 'root.ended',
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
