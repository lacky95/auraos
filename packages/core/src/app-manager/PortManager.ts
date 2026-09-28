/**
 * Cross-container TCP port exposing — make one app's port reachable either on
 * ANOTHER running app's loopback, or on the real supervisor host, with no
 * restart of the app being exposed.
 *
 * ## Why this exists
 *
 * AuraOS apps each live in their own network namespace on the shared docker
 * network `aura-net`; they talk to each other by container name. That isolation
 * breaks software that assumes "one machine, one localhost": an OAuth
 * redirect_uri whitelisted as `http://localhost:5173`, a CLI with a hardcoded
 * loopback address, a browser that treats `localhost` as a special secure
 * origin. `aura port` restores the one-PC illusion on demand, without giving up
 * isolation by default.
 *
 * ## Mechanism
 *
 * A forwarder is a tiny throwaway container running a node TCP pipe proxy
 * (`node -e`, node is guaranteed in `aura-base`). It is parameterised entirely
 * through env vars, so no user-controlled string is ever interpolated into a
 * shell.
 *
 *   into <targetApp>: the forwarder JOINS the target's network namespace
 *     (`--network container:aura-<target>`) and listens on the target's
 *     127.0.0.1:<port>, forwarding to `aura-<source>:<sourcePort>` over
 *     aura-net. Nothing new is published anywhere — the port appears only on
 *     the target's own loopback.
 *
 *   host: the forwarder stays on aura-net and docker PUBLISHES a host port
 *     (`-p <bindAddr>:<hostPort>:5000`) that forwards to
 *     `aura-<source>:<sourcePort>`. Default bind is 127.0.0.1 (host loopback
 *     only); 0.0.0.0 or a NIC IP must be asked for explicitly.
 *
 * ## Lifecycle & state
 *
 * Docker is authoritative: each forwarder carries `aura.port=1` (so the generic
 * sidecar reaper in sidecars.ts skips it) plus `aura.port.spec=<json>` holding
 * its full record, so a shell restart rehydrates the live set with one
 * `docker ps`. The `aura.parent=<ownerInstanceId>` label ties a forwarder to
 * its owner: `ContainerRunner.reapSiblingsOf` removes it when the owner
 * restarts, and `reconcile()` removes it when the owner is gone for good.
 *
 * Exposes are ephemeral by default. A `sticky` expose ALSO writes a declaration
 * to `<dataDir>/aura/ports/.state/<ownerInstanceId>.json`, which `reapply()`
 * replays after the owner's container comes back up (mirrors MountManager).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppRegistry } from './AppRegistry.js';
import type { ContainerRunner } from './ContainerRunner.js';

const HELPER_IMAGE = process.env['AURA_BASE_IMAGE'] ?? 'aura-base';
const SHARED_NETWORK = process.env['AURA_DOCKER_NETWORK'] ?? 'aura-net';

/**
 * The forwarder body. A bidirectional TCP pipe: everything the listener accepts
 * is spliced to a fresh upstream connection and back. Target host/port are
 * re-resolved per connection, so a source container that restarts (new IP, same
 * name) keeps working. Kept to a single line so it survives `node -e` intact.
 */
const PROXY_JS =
  'const net=require("net");' +
  'net.createServer(c=>{' +
  'const u=net.connect(+process.env.PF_TARGET_PORT,process.env.PF_TARGET_HOST);' +
  'c.pipe(u);u.pipe(c);' +
  'const k=()=>{c.destroy();u.destroy()};c.on("error",k);u.on("error",k);' +
  '}).listen(+process.env.PF_LISTEN_PORT,process.env.PF_LISTEN_HOST);';

export type PortExposeKind = 'into' | 'host';

/** What the user ASKED for. Persisted verbatim for sticky/manifest replay. */
export interface ExposeSpec {
  kind: PortExposeKind;
  /** The app whose port is being exposed. */
  sourceAppId: string;
  /** The port inside the source app. */
  sourcePort: number;
  /**
   * Effective public port. For `into` it is the listen port on the target's
   * loopback; for `host` it is the published host port. Defaults to sourcePort.
   */
  port?: number;
  /** `host` only: which host address to bind. Default 127.0.0.1. */
  bindAddr?: string;
  /** Persist as a declaration so it survives an owner restart. */
  sticky?: boolean;
}

/** A forwarder that IS running. Also JSON-serialised into the `aura.port.spec` label. */
export interface AuraPortExpose {
  /** `into-<port>` or `host-<bindAddr>-<port>`. Unique per owner instance. */
  id: string;
  kind: PortExposeKind;
  /** For `into`: the target instance. For `host`: the source instance. */
  ownerInstanceId: string;
  sourceAppId: string;
  sourceInstanceId: string;
  sourcePort: number;
  /** Listen port (into) / published host port (host). */
  port: number;
  /** `host` only. */
  bindAddr?: string;
  sticky: boolean;
  containerName: string;
  createdAt: string;
}

interface PortManagerOpts {
  dataDir: string;
  runner: ContainerRunner;
  registry: AppRegistry;
  /** Resolve an appId to its running instance (any running one). Null if none. */
  resolveRunningInstance(appId: string): { instanceId: string } | null;
}

/** Mirrors ContainerRunner.containerName — the same docker-name sanitisation. */
function containerNameFor(instanceId: string): string {
  return `aura-${instanceId.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}

function sanitizeToken(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export class PortManager {
  constructor(private readonly opts: PortManagerOpts) {}

  // ─── Declarations (sticky) ───────────────────────────────────────────────

  private declFile(instanceId: string): string {
    return join(this.opts.dataDir, 'aura', 'ports', '.state', `${instanceId}.json`);
  }

  private readDecls(instanceId: string): ExposeSpec[] {
    try {
      const raw = JSON.parse(readFileSync(this.declFile(instanceId), 'utf-8')) as unknown;
      return Array.isArray(raw) ? (raw as ExposeSpec[]) : [];
    } catch {
      return [];
    }
  }

  private writeDecls(instanceId: string, specs: ExposeSpec[]): void {
    try {
      mkdirSync(dirname(this.declFile(instanceId)), { recursive: true });
      if (specs.length === 0) rmSync(this.declFile(instanceId), { force: true });
      else writeFileSync(this.declFile(instanceId), JSON.stringify(specs, null, 2));
    } catch (err) {
      console.warn(`[PortManager] could not persist exposes for ${instanceId}: ${(err as Error).message}`);
    }
  }

  private addDecl(instanceId: string, spec: ExposeSpec): void {
    const id = this.specId(spec);
    const kept = this.readDecls(instanceId).filter((s) => this.specId(s) !== id);
    kept.push(spec);
    this.writeDecls(instanceId, kept);
  }

  private dropDecl(instanceId: string, portId: string): void {
    const kept = this.readDecls(instanceId).filter((s) => this.specId(s) !== portId);
    this.writeDecls(instanceId, kept);
  }

  // ─── Identity ────────────────────────────────────────────────────────────

  private specId(spec: ExposeSpec): string {
    const port = spec.port ?? spec.sourcePort;
    if (spec.kind === 'host') return `host-${spec.bindAddr ?? '127.0.0.1'}-${port}`;
    return `into-${port}`;
  }

  private containerNameForExpose(kind: PortExposeKind, ownerInstanceId: string, bindAddr: string, port: number): string {
    if (kind === 'host') return `aura-porth--${sanitizeToken(bindAddr)}--${port}`;
    return `aura-port--${sanitizeToken(ownerInstanceId)}--${port}`;
  }

  // ─── Queries ─────────────────────────────────────────────────────────────

  /**
   * The live set of forwarders, read straight from docker labels. Docker is
   * authoritative, so this needs no in-process cache to stay honest across
   * shell restarts or out-of-band `docker rm`.
   */
  private snapshot(): AuraPortExpose[] {
    let out = '';
    try {
      out = execFileSync(
        'docker',
        ['ps', '-a', '--filter', 'label=aura.port=1', '--format', '{{.Label "aura.port.spec"}}'],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, encoding: 'utf-8' },
      );
    } catch (err) {
      console.warn(`[PortManager] snapshot failed: ${(err as Error).message}`);
      return [];
    }
    const exposes: AuraPortExpose[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      try {
        exposes.push(JSON.parse(line) as AuraPortExpose);
      } catch {
        /* a forwarder without a parseable spec label — ignore */
      }
    }
    return exposes;
  }

  /** Exposes owned by one instance (or all, when no id is given). */
  list(instanceId?: string): AuraPortExpose[] {
    const all = this.snapshot();
    return instanceId ? all.filter((e) => e.ownerInstanceId === instanceId) : all;
  }

  // ─── Mutations ───────────────────────────────────────────────────────────

  async expose(ownerInstanceId: string, spec: ExposeSpec): Promise<AuraPortExpose> {
    const source = this.opts.resolveRunningInstance(spec.sourceAppId);
    if (!source) throw new Error(`source app ${spec.sourceAppId} has no running instance to expose`);
    const sourceInstanceId = source.instanceId;
    const sourceContainer = containerNameFor(sourceInstanceId);

    const kind = spec.kind;
    const port = spec.port ?? spec.sourcePort;
    const bindAddr = spec.bindAddr ?? '127.0.0.1';
    const id = this.specId(spec);
    const containerName = this.containerNameForExpose(kind, ownerInstanceId, bindAddr, port);

    // Already exposed? Deterministic names make this a cheap check and give a
    // clean 409 upstream instead of a docker name-conflict stack trace.
    if (this.list(ownerInstanceId).some((e) => e.id === id)) {
      throw new Error(`${id} is already exposed on ${ownerInstanceId}`);
    }

    const record: AuraPortExpose = {
      id, kind, ownerInstanceId,
      sourceAppId: spec.sourceAppId, sourceInstanceId,
      sourcePort: spec.sourcePort, port,
      ...(kind === 'host' ? { bindAddr } : {}),
      sticky: spec.sticky === true,
      containerName,
      createdAt: new Date().toISOString(),
    };

    const labels = [
      '--label', 'aura.port=1',
      '--label', `aura.parent=${ownerInstanceId}`,
      '--label', `aura.app=${spec.sourceAppId}`,
      '--label', `aura.port.spec=${JSON.stringify(record)}`,
    ];
    const env = [
      '-e', `PF_TARGET_HOST=${sourceContainer}`,
      '-e', `PF_TARGET_PORT=${spec.sourcePort}`,
    ];

    let args: string[];
    if (kind === 'into') {
      if (!this.opts.runner.isRunning(ownerInstanceId)) {
        throw new Error(`target instance ${ownerInstanceId} is not running`);
      }
      args = [
        'run', '-d', '--name', containerName,
        '--network', `container:${containerNameFor(ownerInstanceId)}`,
        '--restart', 'unless-stopped',
        ...labels,
        ...env,
        '-e', 'PF_LISTEN_HOST=127.0.0.1',
        '-e', `PF_LISTEN_PORT=${port}`,
        HELPER_IMAGE, 'node', '-e', PROXY_JS,
      ];
    } else {
      // host: fail fast if the host port is already taken, with a clear message
      // rather than a docker "port is already allocated".
      if (!(await isHostPortFree(bindAddr, port))) {
        throw new Error(`host ${bindAddr}:${port} is already in use`);
      }
      args = [
        'run', '-d', '--name', containerName,
        '--network', SHARED_NETWORK,
        '-p', `${bindAddr}:${port}:5000`,
        '--restart', 'unless-stopped',
        ...labels,
        ...env,
        '-e', 'PF_LISTEN_HOST=0.0.0.0',
        '-e', 'PF_LISTEN_PORT=5000',
        HELPER_IMAGE, 'node', '-e', PROXY_JS,
      ];
    }

    try {
      execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    } catch (err) {
      const msg = stderrOf(err);
      throw new Error(/already in use|already allocated|Conflict/i.test(msg) ? `${id} conflicts: ${msg}` : `could not start forwarder: ${msg}`);
    }

    // The proxy can bind-fail INSIDE the netns (e.g. the port is already taken
    // there) and exit after `docker run` has already returned success. Confirm
    // it is still up; if not, surface its logs and clean up.
    await sleep(400);
    if (!this.isContainerRunning(containerName)) {
      const logs = this.containerLogs(containerName);
      this.forceRemove(containerName);
      throw new Error(`forwarder for ${id} exited immediately: ${logs || '(no output)'}`);
    }

    if (record.sticky) this.addDecl(ownerInstanceId, spec);
    return record;
  }

  remove(ownerInstanceId: string, portId: string): void {
    const existing = this.list(ownerInstanceId).find((e) => e.id === portId);
    if (!existing) throw new Error(`${portId} is not exposed on ${ownerInstanceId}`);
    this.forceRemove(existing.containerName);
    this.dropDecl(ownerInstanceId, portId);
  }

  /**
   * Tear down every forwarder owned by an instance. Called on stop/kill/crash.
   * Keeps the sticky declarations so a later restart re-establishes them.
   * Never throws — teardown paths must not be blocked.
   */
  removeAll(instanceId: string): void {
    for (const e of this.list(instanceId)) {
      try { this.forceRemove(e.containerName); }
      catch (err) { console.warn(`[PortManager] remove ${e.id} failed: ${(err as Error).message}`); }
    }
  }

  // ─── Replay & reconcile ──────────────────────────────────────────────────

  /**
   * Re-create declared exposes for an instance whose container just started.
   * `manifestSpecs` are the always-on exposes from the app's manifest — applied
   * every start but NOT persisted (the manifest is their source of truth).
   * Best-effort: a source that isn't up yet must not fail the spawn.
   */
  async reapply(instanceId: string, manifestSpecs: ExposeSpec[] = []): Promise<{ restored: number; failed: number }> {
    const declared = this.readDecls(instanceId);
    // Manifest specs are always sticky-at-runtime but not re-persisted; dedupe
    // against declarations by id so a manifest expose the user also made sticky
    // isn't created twice.
    const byId = new Map<string, ExposeSpec>();
    for (const s of manifestSpecs) byId.set(this.specId(s), { ...s });
    for (const s of declared) byId.set(this.specId(s), s);
    const specs = [...byId.values()];
    if (specs.length === 0) return { restored: 0, failed: 0 };

    const live = new Set(this.list(instanceId).map((e) => e.id));
    let restored = 0;
    let failed = 0;
    for (const spec of specs) {
      if (live.has(this.specId(spec))) continue; // already up (adopted)
      try {
        await this.expose(instanceId, { ...spec, sticky: false }); // persistence already handled by decls
        restored++;
      } catch (err) {
        failed++;
        console.warn(`[PortManager] could not restore ${this.specId(spec)} on ${instanceId}: ${(err as Error).message}`);
      }
    }
    if (restored || failed) console.log(`[PortManager] reapply ${instanceId}: restored ${restored}, failed ${failed}`);
    return { restored, failed };
  }

  /**
   * Forwarders outlive the shell process (docker keeps them), so after a
   * restart some may belong to instances that are gone for good. Drop any whose
   * owner is not in the live set. No grace ticks: a forwarder is stateless and
   * trivially recreated, so reaping eagerly is safe and simpler than the
   * sidecar reaper's miss-counter.
   */
  reconcile(liveInstanceIds: Set<string>): { reaped: number } {
    let reaped = 0;
    for (const e of this.snapshot()) {
      if (liveInstanceIds.has(e.ownerInstanceId)) continue;
      try {
        this.forceRemove(e.containerName);
        reaped++;
        console.log(`[PortManager] reaped orphan forwarder ${e.id} (dead owner ${e.ownerInstanceId})`);
      } catch (err) {
        console.warn(`[PortManager] could not reap ${e.containerName}: ${(err as Error).message}`);
      }
    }
    if (reaped) console.log(`[PortManager] reconcile: reaped ${reaped}`);
    return { reaped };
  }

  // ─── docker helpers ──────────────────────────────────────────────────────

  private isContainerRunning(name: string): boolean {
    try {
      const out = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', name],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, encoding: 'utf-8' });
      return out.trim() === 'true';
    } catch { return false; }
  }

  private containerLogs(name: string): string {
    try {
      return execFileSync('docker', ['logs', '--tail', '20', name],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, encoding: 'utf-8' }).trim();
    } catch { return ''; }
  }

  private forceRemove(name: string): void {
    execFileSync('docker', ['rm', '-f', name], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stderrOf(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const s = e?.stderr ? e.stderr.toString() : '';
  return (s || e?.message || String(err)).trim();
}

/** Probe whether a host address:port can be bound right now. */
function isHostPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    import('node:net').then(({ createServer }) => {
      const srv = createServer();
      let settled = false;
      const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
      srv.once('error', () => { try { srv.close(); } catch { /* ignore */ } done(false); });
      srv.listen({ port, host, exclusive: true }, () => { srv.close(() => done(true)); });
      setTimeout(() => done(false), 500);
    }).catch(() => resolve(false));
  });
}
