/**
 * The session broker (Phase 5 stream J, D74, phase5-plan.md J.2): how the
 * container runtime opens a session INSIDE a running app container.
 *
 * One lazily created helper container, `aura-session-broker` (BASE_IMAGE,
 * `--privileged --pid=host --cgroupns=host --network none`, the data volume
 * at the shell's data dir, the Docker socket for root tabs only), runs
 * `sleep infinity`. It is a LAUNCHER, not an execution environment: each
 * session is one Engine API exec of `aura-session-enter enter '<spec>'`
 * (os/session-enter/session-enter.c), which enters the app container's
 * namespaces, gives the session its own mount namespace there, drops to the
 * session's identity and runs the command. No session process stays in the
 * broker's namespaces.
 *
 * Only the shell reaches it (the Docker socket; after 5-main nothing else
 * holds one). It is created on the first session request, never at boot
 * (D78), and adopted by its label after a shell restart, never duplicated
 * (D77). The launchers of sessions a previous shell opened have no live
 * bridge any more: the first use reaps them, and every 10 minutes the
 * launchers without a live session record are ended.
 *
 * The helper binary comes from the image (`/os/session-enter/`, built by the
 * Dockerfile), or is compiled from the checkout's source when the image
 * predates it, and is staged on the data volume under a content-addressed
 * name, so a newer shell never runs an older helper.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Duplex } from 'node:stream';
import { BASE_IMAGE } from './BaseImage.js';
import type { EngineClient } from './DockerApi.js';
import { ExecBridgeError, engineSession, type ExecSession, type SessionSpec } from './ExecBridge.js';
import { DOCKER_SOCKET_PATH } from './spawn/socketArgs.js';

const execFileAsync = promisify(execFile);

export const SESSION_BROKER_NAME = 'aura-session-broker';
export const SESSION_BROKER_LABEL = 'aura.helper';
export const SESSION_BROKER_LABEL_VALUE = 'session-broker';
/** The helper as the image builds it (Dockerfile `toolchain` and `development` stages). */
export const SESSION_ENTER_IMAGE_PATH = '/os/session-enter/aura-session-enter';
/** Where the helper is staged, relative to the data dir (root 0700; the broker sees the same path). */
export const SESSION_BROKER_SUBPATH = 'aura/runtime/session-broker';
/** The helper's exit status when the session could not be set up (nothing ran). */
export const SESSION_SETUP_FAILED = 125;
const REAP_INTERVAL_MS = 10 * 60_000;

/** One open session (J.2 session record): the shell's view, never persisted. */
export interface SessionRecord {
  sessionId: string;
  instanceId: string;
  userId?: string;
  kind: SessionSpec['kind'];
  home: SessionSpec['home']['mode'];
  uid: number;
  /** The launcher's pid in the host's PID namespace (the broker's exec). */
  launcherPid: number;
  startedAt: string;
}

/** The target container as the engine reports it. */
export interface SessionTarget {
  /** The full container id: the helper checks the init's cgroup against it. */
  containerId: string;
  /** The container's init in the host's PID namespace. */
  pid: number;
}

/** `docker run` of the broker (golden-tested; nothing here comes from a request). */
export function brokerRunArgs(o: { appDataVolume: string; dataDir: string; image?: string }): string[] {
  return [
    'run', '-d', '--name', SESSION_BROKER_NAME,
    '--label', `${SESSION_BROKER_LABEL}=${SESSION_BROKER_LABEL_VALUE}`,
    '--privileged', '--pid=host', '--cgroupns=host', '--network', 'none',
    '--restart', 'unless-stopped',
    // The homes it clones (open_tree) and the staged helper, at the shell's own paths.
    '--mount', `type=volume,source=${o.appDataVolume},target=${o.dataDir}`,
    // Root tabs only (J.6): cloned into that session's mount namespace, never anywhere else.
    '-v', `${DOCKER_SOCKET_PATH}:${DOCKER_SOCKET_PATH}`,
    '--entrypoint', 'sleep',
    o.image ?? BASE_IMAGE, 'infinity',
  ];
}

/**
 * The helper's input (its `enter` argument). Built from the kernel's spec and
 * the engine's facts only: the helper refuses anything else (session-enter.c
 * `read_spec`).
 */
export function enterSpec(spec: SessionSpec, target: SessionTarget, paths: { dockerCli?: string | null } = {}): Record<string, unknown> {
  if (!/^[0-9a-f]{64}$/.test(target.containerId)) throw new ExecBridgeError(502, 'engine', 'the engine gave no full container id');
  if (!Number.isInteger(target.pid) || target.pid < 2) throw new ExecBridgeError(409, 'not-running', 'the app container has no running init');
  if (spec.home.mode === 'private' && !spec.home.hostPath) throw new ExecBridgeError(409, 'home-denied', 'a private session has no Private Home');
  const root = spec.kind === 'root';
  const env = { ...spec.env };
  if (root) env['PATH'] = `/run/aura-session/bin:${env['PATH'] ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}`;
  return {
    v: 1,
    sid: spec.sessionId,
    container: target.containerId,
    pid: target.pid,
    kind: spec.kind,
    home: spec.home.mode,
    ...(spec.home.mode === 'private' ? { homePath: spec.home.hostPath } : {}),
    uid: spec.uid, gid: spec.gid, groups: spec.groups,
    env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    argv: spec.argv,
    tty: spec.tty,
    ...(spec.passwd !== undefined ? { passwd: spec.passwd } : {}),
    ...(spec.group !== undefined ? { group: spec.group } : {}),
    ...(root && spec.dockerSocket ? { socket: DOCKER_SOCKET_PATH, ...(paths.dockerCli ? { dockerCli: paths.dockerCli } : {}) } : {}),
  };
}

export interface SessionBrokerDeps {
  engine: EngineClient;
  /** The shell's data dir; the broker mounts the data volume at the same path. */
  dataDir: string;
  appDataVolume: string;
  /** The docker CLI (tests fake it). */
  docker?: (args: string[]) => Promise<string>;
  /** The compiled helper to stage (tests); default: the image's, else built from the checkout. */
  helperBinary?: () => Promise<string>;
  /** The docker CLI binary for root tabs (the toolchain mirror's), or null. */
  dockerCli?: () => string | null;
}

export class SessionBroker {
  private ready: Promise<string> | null = null;
  private readonly open = new Map<string, SessionRecord>();
  private reaper: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SessionBrokerDeps) {}

  private docker(args: string[]): Promise<string> {
    return this.deps.docker
      ? this.deps.docker(args)
      : execFileAsync('docker', args, { timeout: 60_000, maxBuffer: 1024 * 1024 }).then((r) => r.stdout);
  }

  /** The open sessions (diagnose, `End`). */
  sessions(): SessionRecord[] {
    return [...this.open.values()];
  }

  /**
   * The broker is up and the helper staged; resolves to the helper's path
   * (the same in the shell and in the broker). Retried after a failure.
   */
  ensure(): Promise<string> {
    if (!this.ready) {
      this.ready = this.setUp().catch((err) => {
        this.ready = null;
        throw err;
      });
    }
    return this.ready;
  }

  private async setUp(): Promise<string> {
    const helper = await this.stageHelper();
    let state = '';
    try {
      state = (await this.docker(['inspect', '-f', `{{.State.Running}} {{index .Config.Labels "${SESSION_BROKER_LABEL}"}}`, SESSION_BROKER_NAME])).trim();
    } catch { /* not there yet */ }
    if (!state) {
      await this.docker(brokerRunArgs({ appDataVolume: this.deps.appDataVolume, dataDir: this.deps.dataDir }));
    } else {
      const [running, label] = state.split(' ');
      // A container of that name that the shell did not make is never used, never removed.
      if (label !== SESSION_BROKER_LABEL_VALUE) {
        throw new ExecBridgeError(409, 'broker-unavailable', `a container named ${SESSION_BROKER_NAME} exists that is not the session broker`);
      }
      if (running !== 'true') await this.docker(['start', SESSION_BROKER_NAME]);
    }
    // Launchers a previous shell opened have no bridge any more (D77): end them, once.
    await this.reap(helper).catch(() => undefined);
    if (!this.reaper) {
      this.reaper = setInterval(() => { void this.reap(helper).catch(() => undefined); }, REAP_INTERVAL_MS);
      this.reaper.unref?.();
    }
    return helper;
  }

  /** Copies the helper onto the data volume under a content-addressed name (root, 0755 in a 0700 dir). */
  private async stageHelper(): Promise<string> {
    const src = await (this.deps.helperBinary ?? defaultHelperBinary.bind(null, this.deps.dataDir))();
    const bytes = readFileSync(src);
    const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const dir = join(this.deps.dataDir, SESSION_BROKER_SUBPATH);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const dest = join(dir, `aura-session-enter-${sha}`);
    const current = existsSync(dest) ? createHash('sha256').update(readFileSync(dest)).digest('hex').slice(0, 16) : null;
    if (current !== sha) {
      const tmp = `${dest}.tmp-${process.pid}`;
      copyFileSync(src, tmp);
      chmodSync(tmp, 0o755);
      renameSync(tmp, dest);
    }
    return dest;
  }

  /** One short command in the broker (end, reap); its stdout. */
  private async brokerCommand(argv: string[]): Promise<string> {
    const { engine } = this.deps;
    const id = await engine.execCreate(SESSION_BROKER_NAME, { Cmd: argv, Tty: true, AttachStdin: false, User: '0' });
    const sock = await engine.execStart(id, true);
    return new Promise((resolve) => {
      const parts: Buffer[] = [];
      sock.on('data', (d: Buffer) => parts.push(d));
      const done = () => resolve(Buffer.concat(parts).toString('utf-8'));
      sock.once('end', done);
      sock.once('close', done);
      sock.once('error', done);
    });
  }

  /** Ends every launcher in the broker that has no open session here. */
  private async reap(helper: string): Promise<void> {
    await this.brokerCommand([helper, 'reap', ...[...this.open.values()].map((r) => String(r.launcherPid))]);
  }

  /** Opens one session in the target container. */
  async openSession(spec: SessionSpec, target: SessionTarget, onOutput: (channel: 1 | 2, data: Buffer) => void): Promise<ExecSession> {
    const helper = await this.ensure();
    const input = enterSpec(spec, target, { dockerCli: spec.kind === 'root' ? this.deps.dockerCli?.() ?? null : null });
    const { engine } = this.deps;
    const id = await engine.execCreate(SESSION_BROKER_NAME, {
      Cmd: [helper, 'enter', JSON.stringify(input)], Tty: spec.tty, AttachStdin: true, User: '0',
    });
    const sock: Duplex = await engine.execStart(id, spec.tty);
    let launcherPid = 0;
    for (let i = 0; i < 20 && !launcherPid; i++) {
      const r = await engine.execInspect(id).catch(() => null);
      launcherPid = r?.Pid ?? 0;
      if (!launcherPid && r && !r.Running) break;
      if (!launcherPid) await new Promise((res) => setTimeout(res, 50));
    }
    const record: SessionRecord = {
      sessionId: spec.sessionId, instanceId: spec.instanceId, ...(spec.userId ? { userId: spec.userId } : {}),
      kind: spec.kind, home: spec.home.mode, uid: spec.uid, launcherPid, startedAt: new Date().toISOString(),
    };
    if (launcherPid) this.open.set(spec.sessionId, record);
    const session = engineSession(engine, id, sock, spec, onOutput, {
      // The caller went away (disconnect, End, timeout): end the launcher, so the session hangs up.
      onEnd: () => { if (launcherPid) void this.brokerCommand([helper, 'end', String(launcherPid)]).catch(() => undefined); },
    });
    void session.exited.then(() => { this.open.delete(spec.sessionId); }, () => { this.open.delete(spec.sessionId); });
    return session;
  }
}

/** The image's helper, or one compiled from the checkout when the image predates stream J. */
async function defaultHelperBinary(dataDir: string): Promise<string> {
  const fromImage = process.env['AURA_SESSION_ENTER'] ?? SESSION_ENTER_IMAGE_PATH;
  if (existsSync(fromImage)) return fromImage;
  const source = fileURLToPath(new URL('../../../../os/session-enter/session-enter.c', import.meta.url));
  if (!existsSync(source)) {
    throw new ExecBridgeError(409, 'capability-missing', 'capability-missing: sessionExec (the session launcher aura-session-enter is not installed)');
  }
  const sha = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 16);
  const dir = join(dataDir, SESSION_BROKER_SUBPATH, 'build');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = join(dir, `aura-session-enter-${sha}`);
  if (!existsSync(out)) {
    await execFileAsync('cc', ['-std=gnu11', '-O2', '-Wall', '-static', '-o', `${out}.tmp`, source], { timeout: 120_000 });
    renameSync(`${out}.tmp`, out);
  }
  return out;
}
