import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { defaultKv } from '@aura/kv-store';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import type { AppRegistry } from './AppRegistry.js';
import type { ContainerRunner } from './ContainerRunner.js';
import type { InstanceTokens } from './InstanceTokens.js';
import type { FanoutTarget, MountManager } from './MountManager.js';
import { MOUNT_ROOT_PATH } from './MountManager.js';
import type { PermissionManager } from '../permissions/PermissionManager.js';
import type { AppManifest } from '../types/manifest.js';
import { toolsGrant } from './tool-allowlist.js';
import {
  MY_TOOLS_PATH, SHARED_HOME_PATH, listToolchainBinaries, provisionAllowlist, readSidecarMap, toolchainMirrorBin,
} from './tool-provision.js';
import { SIDECAR_TOOL_RE, effectiveSidecarTools } from './sidecar-tools.js';
import { userHomeSubpath } from '../scopes/home.js';
import {
  SpecError, resolveSidecarSpec, specHash,
  type ResolvedSidecarSpec, type SidecarSpawnRequest,
} from './sidecar-spec.js';

/**
 * OS-managed sidecars: the official way for an app to run a foreign image
 * next to itself. The app asks (`POST /api/instances/:id/sidecars`, or
 * `osSidecars()` in the SDK); the OS validates the request against the app's
 * `services[]` templates and permissions (sidecar-spec.ts) and does the
 * `docker run` — the app needs no docker tool and never touches the socket.
 *
 * Built like PortManager: docker is the source of truth. Every OS sidecar
 * carries its full record in labels, so a shell restart re-learns everything
 * from `docker ps` (reconcile). `aura.parent` makes the existing reaper treat
 * it like any sidecar — removed on stop and crash, skipped by orphan adoption.
 *
 *   aura.parent=<instanceId>  aura.app=<appId>  aura.service=<name>
 *   aura.managed=os           aura.sidecar.template=<template>
 *   aura.sidecar.owner=<sidecar that spawned it, or ->
 *   aura.sidecar.spec=<json SpecRecord>
 *
 * Apps that run docker themselves (SDK docker mode, raw `docker run`) keep
 * working unchanged; their containers lack `aura.managed=os`, and this
 * manager never touches them (a name collision is a 409, unless the caller
 * asks to take over its own app-managed container).
 *
 * Every docker call is async: dynamic sidecars come in bursts, and the shell's
 * event loop serves every app at once.
 */

export interface SidecarMountsView { own: boolean; inherit: boolean; exclude: string[]; forceRo: boolean }

/** JSON stored in the `aura.sidecar.spec` label. */
interface SpecRecord {
  name: string;
  template: string;
  image: string;
  specHash: string;
  nonce?: string;
  port?: number;
  mounts: SidecarMountsView;
  owner?: string;
  /** Has its own tools dir (template `tools`); absent otherwise. */
  ownTools?: true;
  createdAt: string;
}

/** Tools of one OS sidecar (`GET …/sidecars/:name/tools`). */
export interface SidecarToolsView {
  /** Own tools dir at /aura/my-tools (template declares `tools`). */
  own: boolean;
  /** Shares the app's whole set instead (`inheritTools`). */
  inherited: boolean;
  /** The template's `tools` (persistent; edit the manifest). */
  template: string[];
  /** Granted at runtime to this running sidecar (survives a recreate, not the instance). */
  runtime: string[];
  /** Binaries actually at /aura/my-tools: (template ∪ runtime) ∩ the app's tools[]. */
  effective: string[];
  /** Named tools the app itself does not hold — not provisioned. */
  ignored: string[];
}

/** What the API returns for an OS sidecar. */
export interface OsSidecar {
  name: string;
  template: string;
  image: string;
  /** Docker container name — also its DNS name on aura-net. */
  containerName: string;
  /** Where the app reaches it (== containerName). */
  host: string;
  port?: number;
  state: string;
  createdAt: string;
  /** Sidecar that spawned this one (grandchild), if any. */
  owner?: string;
  managedBy: 'os';
  mounts: SidecarMountsView;
  specHash: string;
}

export interface ExecRequest {
  cmd: string[];
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
  /** Small stdin payload (≤ 64 KiB). */
  stdin?: string;
  /** Default 30 s, max 10 min. */
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface Caller {
  instanceId: string;
  /** Set when an OS sidecar (with its own token) is calling — a grandchild spawn. */
  sidecar?: string;
}

interface SidecarManagerOpts {
  runner: ContainerRunner;
  registry: AppRegistry;
  permissions: PermissionManager;
  tokens: InstanceTokens;
  mounts: MountManager;
  /** Live instance → app + its shell-side data dir. */
  instance(instanceId: string): { appId: string; instanceDataDir: string } | null;
  /**
   * A sidecar was created or removed — lets AppManager refresh its sidecar
   * cache now instead of at the next reconciler tick (else `GET sidecars`
   * and `aura get sc` show the old state for up to a tick).
   */
  changed?(): void;
}

/**
 * Running OS sidecars allowed per instance. An OS setting: Valkey key
 * `os:sidecars` → `{ "maxPerInstance": n }` (editable through
 * `/api/kv/os/sidecars`), else $AURA_SIDECAR_MAX_PER_INSTANCE, else 32.
 */
const DEFAULT_MAX_PER_INSTANCE = 32;
export async function sidecarLimit(): Promise<number> {
  try {
    const v = await defaultKv().getValue<{ maxPerInstance?: unknown }>('os', 'sidecars');
    const n = Number(v?.maxPerInstance);
    if (Number.isInteger(n) && n > 0) return n;
  } catch { /* KV not running (tests, early boot) — fall through */ }
  const env = Number(process.env['AURA_SIDECAR_MAX_PER_INSTANCE']);
  return Number.isInteger(env) && env > 0 ? env : DEFAULT_MAX_PER_INSTANCE;
}
const MAX_STDIN = 64 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
const PULL_TIMEOUT_MS = 10 * 60_000;
const DOCKER_SOCK = '/var/run/docker.sock';

interface DockerResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }

/** Run docker; never rejects — the caller decides what a non-zero exit means. */
function docker(args: string[], opts: { timeoutMs?: number; input?: string; maxBuffer?: number } = {}): Promise<DockerResult> {
  return new Promise((resolve) => {
    // Own timer instead of execFile's `timeout`: the docker CLI forwards the
    // SIGTERM to the exec'd process and then exits CLEANLY, so execFile
    // reports no error at all and a timeout would read as success.
    let timedOut = false;
    const child = execFile('docker', args, {
      maxBuffer: opts.maxBuffer ?? MAX_OUTPUT,
      encoding: 'utf-8',
    }, (err, stdout, stderr) => {
      clearTimeout(timer);
      clearTimeout(hardKill);
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({
        code: timedOut ? null : e ? (typeof e.code === 'number' ? e.code : null) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? '') || (e && typeof e.code !== 'number' ? e.message : ''),
        timedOut,
        truncated: e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      });
    });
    let hardKill: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      hardKill = setTimeout(() => child.kill('SIGKILL'), 2_000);
    }, opts.timeoutMs ?? 60_000);
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

async function dockerOk(args: string[], what: string, timeoutMs?: number): Promise<string> {
  const r = await docker(args, { timeoutMs });
  if (r.code !== 0) throw new Error(`${what}: ${r.stderr.trim() || `docker exited ${r.code}`}`);
  return r.stdout;
}

export function sidecarContainerName(instanceId: string, name: string): string {
  return `aura-${instanceId}--${name}`;
}

export class SidecarManager {
  /** consumerKey → what fan-out (and tool refresh) needs about each live OS sidecar. */
  private live = new Map<string, { instanceId: string; name: string; mounts: SidecarMountsView; template?: string; ownTools?: boolean }>();
  private locks = new Map<string, Promise<unknown>>();
  private pulls = new Map<string, Promise<void>>();

  constructor(private readonly opts: SidecarManagerOpts) {}

  /** Serialise work on one container name (concurrent spawn/delete of the same sidecar). */
  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    this.locks.set(key, run);
    try { return await run; } finally { if (this.locks.get(key) === run) this.locks.delete(key); }
  }

  // ─── Who may act on which sidecar ──────────────────────────────────────

  /**
   * An app acts on all its sidecars. A SIDECAR (calling with its own token)
   * acts only on the sidecars it spawned — and theirs, down the owner chain —
   * unless the app holds `sidecars.manageAll`. So by default an agent in a
   * sidecar can't exec into, read or delete its siblings or its parent.
   */
  private mayManageAll(instanceId: string, caller: Caller | undefined): boolean {
    if (!caller?.sidecar) return true;
    const appId = this.opts.instance(instanceId)?.appId;
    return Boolean(appId && this.opts.permissions.hasPermission(appId, 'sidecars.manageAll'));
  }

  /** Is `name` spawned (directly or further down) by `ancestor`? */
  private static descends(all: OsSidecar[], name: string, ancestor: string): boolean {
    const byName = new Map(all.map((s) => [s.name, s]));
    const seen = new Set<string>();
    for (let cur = byName.get(name); cur?.owner && !seen.has(cur.name); cur = byName.get(cur.owner)) {
      seen.add(cur.name);
      if (cur.owner === ancestor) return true;
    }
    return false;
  }

  /** Throws 403 unless `caller` may act on sidecar `name` (see mayManageAll). */
  async authorize(instanceId: string, name: string, caller: Caller | undefined): Promise<void> {
    if (this.mayManageAll(instanceId, caller)) return;
    if (!SidecarManager.descends(await this.list(instanceId), name, caller!.sidecar!)) {
      throw new SpecError(403, `sidecar '${caller!.sidecar}' may only manage the sidecars it spawned — '${name}' is not one of them (the app's permission sidecars.manageAll lifts this)`);
    }
  }

  // ─── Queries ───────────────────────────────────────────────────────────

  /**
   * OS sidecars of an instance, straight from docker. With a sidecar `caller`
   * only what it may manage (see authorize).
   */
  async list(instanceId: string, caller?: Caller): Promise<OsSidecar[]> {
    const all = await this.listAll(instanceId);
    if (this.mayManageAll(instanceId, caller)) return all;
    return all.filter((s) => SidecarManager.descends(all, s.name, caller!.sidecar!));
  }

  private async listAll(instanceId: string): Promise<OsSidecar[]> {
    const out = await dockerOk(['ps', '-a',
      '--filter', 'label=aura.managed=os', '--filter', `label=aura.parent=${instanceId}`,
      '--format', '{{.Names}}\t{{.State}}\t{{.Label "aura.sidecar.spec"}}'], 'docker ps');
    return out.split('\n').filter(Boolean).flatMap((line) => {
      const [name, state, spec] = line.split('\t');
      const rec = parseRecord(spec);
      return rec ? [toView(name!, state ?? 'unknown', rec)] : [];
    });
  }

  async get(instanceId: string, name: string): Promise<OsSidecar | null> {
    const found = await this.inspect(sidecarContainerName(instanceId, name));
    if (!found || found.labels['aura.managed'] !== 'os' || found.labels['aura.parent'] !== instanceId) return null;
    const rec = parseRecord(found.labels['aura.sidecar.spec']);
    return rec ? toView(found.name, found.state, rec) : null;
  }

  /** Inheriting OS sidecars of an instance — MountManager's fan-out targets. */
  fanoutTargets(instanceId: string): FanoutTarget[] {
    return [...this.live.entries()]
      .filter(([, v]) => v.instanceId === instanceId && v.mounts.inherit)
      .map(([consumer, v]) => ({ consumer, exclude: v.mounts.exclude, forceRo: v.mounts.forceRo }));
  }

  /** `<instanceId>--<name>` of every live OS sidecar (mount reconcile needs them). */
  liveConsumerKeys(): string[] {
    return [...this.live.keys()];
  }

  // ─── Spawn ─────────────────────────────────────────────────────────────

  async spawn(instanceId: string, req: SidecarSpawnRequest, caller: Caller): Promise<{ created: boolean; sidecar: OsSidecar }> {
    const inst = this.opts.instance(instanceId);
    if (!inst) throw new SpecError(404, `Instance not found: ${instanceId}`);
    const manifest = this.opts.registry.getById(inst.appId);
    if (!manifest) throw new SpecError(404, `App not found: ${inst.appId}`);
    const rt = this.opts.runner.sidecarRuntime();
    const appDataSubpath = dirname(inst.instanceDataDir).slice(rt.dataDir.length).replace(/^\/+/, '');

    // Legacy per-app volumes only matter for templates the SDK ran before.
    const legacy = new Set<string>();
    for (const v of (manifest.services ?? []).flatMap((s) => s.volumes ?? [])) {
      const name = `aura-${inst.appId}-${v.name}`;
      if ((await docker(['volume', 'inspect', name])).code === 0) legacy.add(name);
    }
    const spec = resolveSidecarSpec(req, {
      appId: inst.appId,
      instanceId,
      manifest,
      can: (p) => this.opts.permissions.hasPermission(inst.appId, p),
      appDataSubpath,
      appDataVolume: rt.appDataVolume,
      legacyVolumeExists: (n) => legacy.has(n),
      hasDockerTool: toolsGrant(manifest.tools ?? [], 'docker'),
    });
    const hash = specHash(spec);
    const container = sidecarContainerName(instanceId, spec.name);

    return this.locked(container, async () => {
      const existing = await this.inspect(container);
      // A sidecar may (re)spawn only within its own subtree: a name that is
      // already someone else's is not its to replace.
      if (existing && !this.mayManageAll(instanceId, caller)
        && !(existing.labels['aura.managed'] === 'os' && SidecarManager.descends(await this.listAll(instanceId), spec.name, caller.sidecar!))) {
        throw new SpecError(403, `sidecar '${caller.sidecar}' may not replace '${spec.name}' — it did not spawn it (the app's permission sidecars.manageAll lifts this)`);
      }
      if (existing) {
        const managed = existing.labels['aura.managed'] === 'os';
        if (!managed) {
          if (!(req.takeover && existing.labels['aura.parent'] === instanceId)) {
            throw new SpecError(409, `${container} exists but is not OS-managed (the app runs it itself) — pass takeover: true to replace your own app-managed container`);
          }
        } else {
          const rec = parseRecord(existing.labels['aura.sidecar.spec']);
          if (rec && rec.specHash === hash && existing.state === 'running') {
            // Same spec, already up: adopt. Re-learn its nonce and make sure its
            // mounts are there (idempotent — present ones are skipped).
            if (rec.nonce) this.opts.tokens.register(instanceId, rec.nonce, spec.name);
            this.track(instanceId, spec.name, rec.mounts, rec);
            if (rec.ownTools) this.provisionTools(instanceId, spec.name, inst.appId, spec.template);
            if (rec.mounts.own || rec.mounts.inherit) {
              await this.opts.mounts.reapplyConsumer(`${instanceId}--${spec.name}`, rec.mounts);
            }
            return { created: false, sidecar: toView(container, existing.state, rec) };
          }
          if (rec && rec.specHash !== hash && req.replace === false) {
            throw new SpecError(409, `${container} runs a different spec — pass replace: true (the default) to recreate it`);
          }
        }
        // Recreate. Own mount declarations stay; the binds go with the container.
        this.opts.mounts.removeAll(`${instanceId}--${spec.name}`);
        await dockerOk(['rm', '-f', container], `docker rm ${container}`);
        this.untrack(instanceId, spec.name);
      } else {
        // Running ones only — a stopped sidecar holds a name, not resources.
        const running = (await this.listAll(instanceId)).filter((x) => x.state === 'running').length;
        const limit = await sidecarLimit();
        if (running >= limit) {
          throw new SpecError(429, `${instanceId} already runs ${running} OS sidecars (limit ${limit} — OS setting os:sidecars.maxPerInstance)`);
        }
      }

      await this.ensureImage(spec.image);
      for (const v of spec.volumes) if (v.subpath) mkdirSync(join(rt.dataDir, v.subpath), { recursive: true });
      const wantsMountRoot = spec.mounts.own || spec.mounts.inherit;
      const consumer = `${instanceId}--${spec.name}`;
      if (wantsMountRoot) mkdirSync(this.opts.runner.mountRootDir(consumer), { recursive: true });
      // Own tools are in place before the container starts (the dir is
      // mounted by inode — it must exist, and the first exec must find them).
      if (spec.ownTools) this.provisionTools(instanceId, spec.name, inst.appId, spec.template);

      const env = await this.environment(instanceId, inst.appId, spec);
      if (spec.seed) await this.seed(instanceId, spec, appDataSubpath, env);

      const token = spec.inheritIdentity ? this.opts.tokens.mint(instanceId, spec.name) : null;
      const record: SpecRecord = {
        name: spec.name, template: spec.template, image: spec.image, specHash: hash,
        ...(token ? { nonce: token.nonce } : {}),
        ...(spec.port !== undefined ? { port: spec.port } : {}),
        mounts: spec.mounts,
        ...(caller.sidecar ? { owner: caller.sidecar } : {}),
        ...(spec.ownTools ? { ownTools: true as const } : {}),
        createdAt: new Date().toISOString(),
      };
      const args = await this.createArgs(instanceId, inst.appId, container, spec, record, env, token?.token ?? null);
      const id = (await dockerOk(args, `docker create ${container}`)).trim();
      const started = await docker(['start', id]);
      if (started.code !== 0) {
        await docker(['rm', '-f', id]);
        if (token) this.opts.tokens.forget(instanceId, spec.name);
        throw new Error(`docker start ${container}: ${started.stderr.trim()}`);
      }

      // A runtime that dies on boot (bad command, missing config) should fail
      // the spawn with its own words, not leave a corpse behind.
      await new Promise((r) => setTimeout(r, 400));
      const after = await this.inspect(container);
      if (!after || after.state !== 'running') {
        const logs = await docker(['logs', '--tail', '20', container]);
        await docker(['rm', '-f', container]);
        if (token) this.opts.tokens.forget(instanceId, spec.name);
        throw new Error(`${container} exited right after start:\n${(logs.stdout + logs.stderr).trim() || '(no output)'}`);
      }

      this.track(instanceId, spec.name, spec.mounts, record);
      this.opts.changed?.();
      if (wantsMountRoot) await this.opts.mounts.reapplyConsumer(consumer, spec.mounts);
      if (req.wait?.ready && spec.readiness && spec.port) {
        await waitForHttp(container, spec.port, spec.readiness.path, req.wait.timeoutMs ?? spec.readiness.timeoutMs);
      } else if ((req.wait?.port || req.wait?.ready) && spec.port) {
        await waitForPort(container, spec.port, req.wait.timeoutMs ?? 60_000);
      }
      return { created: true, sidecar: toView(container, 'running', record) };
    });
  }

  private async ensureImage(image: string): Promise<void> {
    if ((await docker(['image', 'inspect', '--format', '{{.Id}}', image])).code === 0) return;
    let pull = this.pulls.get(image);
    if (!pull) {
      pull = dockerOk(['pull', image], `docker pull ${image}`, PULL_TIMEOUT_MS).then(() => undefined);
      this.pulls.set(image, pull);
      void pull.finally(() => this.pulls.delete(image)).catch(() => undefined);
    }
    await pull;
  }

  /** Env from envInherit (OS Context, then the app container's env), then the spec's own. */
  private async environment(instanceId: string, appId: string, spec: ResolvedSidecarSpec): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    if (spec.envInherit.length) {
      const ctx = await this.opts.runner.resolveContextEnv().catch(() => ({} as Record<string, string>));
      let parentEnv: Record<string, string> | null = null;
      for (const name of spec.envInherit) {
        if (ctx[name] !== undefined) { env[name] = ctx[name]; continue; }
        parentEnv ??= await this.containerEnv(`aura-${instanceId}`);
        if (parentEnv[name] !== undefined) env[name] = parentEnv[name];
      }
    }
    void appId;
    return { ...env, ...spec.env };
  }

  private async containerEnv(container: string): Promise<Record<string, string>> {
    const r = await docker(['inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', container]);
    const env: Record<string, string> = {};
    for (const line of r.stdout.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
    }
    return env;
  }

  private volumeArgs(spec: ResolvedSidecarSpec): string[] {
    return spec.volumes.flatMap((v) => ['--mount',
      `type=volume,source=${v.source},target=${v.target}${v.subpath ? `,volume-subpath=${v.subpath}` : ''}`]);
  }

  /**
   * Where "this data was already seeded" is recorded. The marker belongs to
   * the DATA the seed writes, not to a sidecar name:
   *   • volumes → one marker per set of resolved volume dirs, so shared
   *     (`shared: true`) dirs are seeded exactly once, whoever uses them;
   *   • a legacy per-app docker volume (the SDK path's) → already seeded: it
   *     holds the data the SDK's onSeed put there (null = never seed);
   *   • no volumes → one marker per sidecar name.
   */
  static seedMarker(dataDir: string, appDataSubpath: string, spec: ResolvedSidecarSpec): string | null {
    if (spec.volumes.some((v) => !v.subpath)) return null;
    const key = spec.volumes.length
      ? createHash('sha256').update(spec.volumes.map((v) => v.subpath!).sort().join('\n')).digest('hex').slice(0, 16)
      : `name-${spec.name}`;
    return join(dataDir, appDataSubpath, '.sidecars', '.seeded', key);
  }

  /**
   * One-shot init run before the first start, through the image's own
   * entrypoint (like `command`); see seedMarker for when it counts as done.
   */
  private async seed(instanceId: string, spec: ResolvedSidecarSpec, appDataSubpath: string, env: Record<string, string>): Promise<void> {
    const rt = this.opts.runner.sidecarRuntime();
    const marker = SidecarManager.seedMarker(rt.dataDir, appDataSubpath, spec);
    if (marker === null) return;
    // Markers written before markers were keyed by data (per sidecar name).
    const before = join(rt.dataDir, appDataSubpath, '.sidecars', spec.name, '.aura-seeded');
    // Serialised per marker: two sidecars on the same shared data seed once.
    return this.locked(`seed:${marker}`, async () => {
    if (existsSync(marker) || existsSync(before)) return;
    // aura.mount=1 keeps the throwaway out of sidecar listings; aura.parent
    // lets the reaper remove it if the instance dies mid-seed.
    const args = ['run', '--rm', '--network', rt.network, '--label', 'aura.mount=1', '--label', `aura.parent=${instanceId}`,
      ...this.volumeArgs(spec),
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      ...(spec.user ? ['--user', spec.user] : []),
      ...(spec.workdir ? ['--workdir', spec.workdir] : []),
      spec.image, ...spec.seed!.command];
    const r = await docker(args, { timeoutMs: 10 * 60_000 });
    if (r.code !== 0) throw new Error(`seed for ${spec.name} failed: ${(r.stderr || r.stdout).trim().slice(-2000)}`);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, new Date().toISOString());
    });
  }

  /**
   * `services[].prePull`: fetch the images of an app's templates ahead of the
   * first spawn (called when an app is installed or loaded). Background, best
   * effort, missing images only — a failed pull just means the spawn pulls.
   */
  async prePull(manifest: Pick<AppManifest, 'id' | 'services'>): Promise<void> {
    for (const svc of (manifest.services ?? []).filter((x) => x.prePull)) {
      try {
        await this.ensureImage(svc.image);
      } catch (err) {
        console.warn(`[SidecarManager] prePull ${svc.image} for ${manifest.id} failed: ${(err as Error).message}`);
      }
    }
  }

  private async createArgs(
    instanceId: string, appId: string, container: string, spec: ResolvedSidecarSpec,
    record: SpecRecord, env: Record<string, string>, token: string | null,
  ): Promise<string[]> {
    const rt = this.opts.runner.sidecarRuntime();
    const consumer = `${instanceId}--${spec.name}`;
    const identity: Record<string, string> = spec.inheritIdentity ? {
      AURA_APP_ID: appId,
      AURA_INSTANCE_ID: instanceId,
      AURA_SIDECAR_NAME: spec.name,
      AURA_OS_URL: rt.osApiBase,
      OS_API_BASE: rt.osApiBase,
      AURA_SHELL_HOSTNAME: rt.shellHostname,
      ...(token ? { AURA_INSTANCE_TOKEN: token } : {}),
    } : {};
    const manifest = this.opts.registry.getById(appId);
    const a: string[] = [
      'create', '--name', container, '--network', rt.network, '--restart', spec.restart,
      '--label', `aura.parent=${instanceId}`,
      '--label', `aura.app=${appId}`,
      '--label', `aura.service=${spec.name}`,
      '--label', 'aura.managed=os',
      '--label', `aura.sidecar.template=${spec.template}`,
      '--label', `aura.sidecar.owner=${record.owner ?? '-'}`,
      '--label', `aura.sidecar.spec=${JSON.stringify(record)}`,
      ...spec.dns.flatMap((d) => ['--dns', d]),
      ...spec.publish.flatMap((p) => ['-p', `${p.host}:${p.container}`]),
      ...this.volumeArgs(spec),
      // inheritHome: the user's shared HOME, the same mount every container
      // app gets (ContainerRunner) — the sidecar doesn't exceed its app.
      ...(spec.inheritHome
        ? ['--mount', `type=volume,source=${rt.appDataVolume},target=${SHARED_HOME_PATH},volume-subpath=${userHomeSubpath()}`]
        : []),
      // HOME after the template env (a template can't point it elsewhere while
      // the mount is there); identity last: a template env key can't replace
      // the OS's own values.
      ...Object.entries({ ...env, ...(spec.inheritHome ? { HOME: SHARED_HOME_PATH } : {}), ...identity })
        .flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      ...spec.capabilities.flatMap((c) => ['--cap-add', c]),
      ...spec.devices.flatMap((d) => ['--device', d]),
      ...(spec.privileged ? ['--privileged'] : []),
      ...(spec.limits?.memory ? ['--memory', spec.limits.memory] : []),
      ...(spec.limits?.cpus ? ['--cpus', String(spec.limits.cpus)] : []),
      ...(spec.user ? ['--user', spec.user] : []),
      ...(spec.workdir ? ['--workdir', spec.workdir] : []),
      ...(spec.inheritPermissions && manifest?.permissions?.length ? ['-e', `AURA_PERMISSIONS=${manifest.permissions.join(',')}`] : []),
    ];
    // inheritTools: the app's own dir (whole set); ownTools: the sidecar's dir.
    if (spec.inheritTools) a.push(...await this.toolArgs(instanceId, spec.image));
    else if (spec.ownTools) a.push(...await this.toolArgs(consumer, spec.image));
    if (spec.mounts.own || spec.mounts.inherit) {
      a.push('--mount', `type=volume,source=${rt.appDataVolume},target=${MOUNT_ROOT_PATH},volume-subpath=${this.opts.runner.mountRootSubpath(consumer)}`,
        '-e', `AURA_MOUNT_ROOT=${MOUNT_ROOT_PATH}`);
    }
    // resolveSidecarSpec already refused this unless the app holds docker itself.
    if (spec.inheritDockerSocket) a.push('-v', `${DOCKER_SOCK}:${DOCKER_SOCK}`);
    a.push(spec.image, ...spec.command);
    return a;
  }

  /**
   * A tools allowlist dir, mounted the way ContainerRunner mounts the app's
   * (port of the SDK's `inheritTools`). `dirKey` is the instance id for the
   * app's own set, or the consumer key `<inst>--<name>` for a sidecar's own.
   */
  private async toolArgs(dirKey: string, image: string): Promise<string[]> {
    const rt = this.opts.runner.sidecarRuntime();
    const r = await docker(['image', 'inspect', image, '--format', '{{range .Config.Env}}{{println .}}{{end}}']);
    const basePath = r.stdout.split('\n').find((l) => l.startsWith('PATH='))?.slice('PATH='.length)
      ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    return [
      ...(rt.toolsMode === 'symlink'
        ? ['--mount', `type=volume,source=${rt.appDataVolume},target=/aura/all-tools,volume-subpath=aura/toolchain/bin,readonly`]
        : []),
      '--mount', `type=volume,source=${rt.appDataVolume},target=${MY_TOOLS_PATH},volume-subpath=aura/runtime/${dirKey}/tools,readonly`,
      '-v', `${rt.workspaceRoot}/packages:/workspace/packages:ro`,
      '--mount', `type=volume,source=${rt.nodeModulesVolume},target=/workspace/node_modules,readonly`,
      '-e', `PATH=${MY_TOOLS_PATH}:${basePath}`,
      '-v', `${rt.workspaceRoot}/os/bashrc.aura.sh:/etc/profile.d/aura-prompt.sh:ro`,
    ];
  }

  // ─── Tools of a sidecar ─────────────────────────────────────────────────
  //
  // A template with `tools` gives each of its sidecars its own allowlist dir
  // (`aura/runtime/<inst>--<name>/tools`, mounted at /aura/my-tools). What is
  // in it = (template tools ∪ runtime grants) ∩ the app's tools[]. The dir is
  // refilled IN PLACE (provisionAllowlist keeps its inode), so every change is
  // live in the running container — no recreate. Runtime grants are persisted
  // next to the mount declarations' kind of state, so a recreated sidecar gets
  // them back; they go when the sidecar is deleted or its instance stops.

  private toolsDeclFile(consumer: string): string {
    return join(this.opts.runner.sidecarRuntime().dataDir, 'aura', 'runtime', '.state', `${consumer}.tools.json`);
  }

  private readGrants(consumer: string): string[] {
    try {
      const raw = JSON.parse(readFileSync(this.toolsDeclFile(consumer), 'utf-8')) as unknown;
      return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
    } catch { return []; }   // absent or corrupt — nothing granted
  }

  private writeGrants(consumer: string, grants: string[]): void {
    const file = this.toolsDeclFile(consumer);
    mkdirSync(dirname(file), { recursive: true });
    if (grants.length === 0) rmSync(file, { force: true });
    else writeFileSync(file, JSON.stringify(grants, null, 2));
  }

  /** Drop a sidecar's own tools dir and its runtime grants. */
  private forgetTools(consumer: string): void {
    try { this.opts.runner.clearToolsDir(consumer); } catch { /* ignore */ }
    try { rmdirSync(dirname(this.opts.runner.toolsDir(consumer))); } catch { /* busy or absent */ }
    try { rmSync(this.toolsDeclFile(consumer), { force: true }); } catch { /* ignore */ }
  }

  /** Compute the sidecar's tool set; with `apply`, (re)fill its dir. */
  private computeTools(instanceId: string, name: string, appId: string, template: string, apply: boolean): SidecarToolsView {
    const consumer = `${instanceId}--${name}`;
    const manifest = this.opts.registry.getById(appId);
    const tpl = (manifest?.services ?? []).find((s) => s.name === template);
    const dataDir = this.opts.runner.sidecarRuntime().dataDir;
    // Containers enumerate the in-volume mirror in both modes (see
    // ContainerRunner.provisionToolsDir).
    const store = toolchainMirrorBin(dataDir);
    const templateTools = tpl?.tools ?? [];
    const runtime = this.readGrants(consumer);
    const r = effectiveSidecarTools(manifest?.tools ?? [], templateTools, runtime,
      listToolchainBinaries(store), readSidecarMap(store));
    if (apply) {
      provisionAllowlist({ dataDir, dir: this.opts.runner.toolsDir(consumer), tools: r.effective, legacyStoreBin: store });
    }
    return { own: true, inherited: false, template: templateTools, runtime, ...r };
  }

  private provisionTools(instanceId: string, name: string, appId: string, template: string): SidecarToolsView {
    return this.computeTools(instanceId, name, appId, template, true);
  }

  /** The sidecar and its app, or 404. */
  private async toolsTarget(instanceId: string, name: string): Promise<{ appId: string; sc: OsSidecar; own: boolean }> {
    const appId = this.opts.instance(instanceId)?.appId;
    if (!appId) throw new SpecError(404, `Instance not found: ${instanceId}`);
    const found = await this.inspect(sidecarContainerName(instanceId, name));
    const rec = found && found.labels['aura.managed'] === 'os' && found.labels['aura.parent'] === instanceId
      ? parseRecord(found.labels['aura.sidecar.spec']) : null;
    if (!found || !rec) throw new SpecError(404, `no OS sidecar '${name}' in ${instanceId}`);
    return { appId, sc: toView(found.name, found.state, rec), own: rec.ownTools === true };
  }

  /** What `name` holds at /aura/my-tools, and why. */
  async listTools(instanceId: string, name: string): Promise<SidecarToolsView> {
    const { appId, sc, own } = await this.toolsTarget(instanceId, name);
    if (own) return this.computeTools(instanceId, name, appId, sc.template, false);
    const tpl = (this.opts.registry.getById(appId)?.services ?? []).find((s) => s.name === sc.template);
    return { own: false, inherited: tpl?.inheritTools === true, template: [], runtime: [], effective: [], ignored: [] };
  }

  /**
   * Grant tools to one running sidecar (additive, persisted until it is
   * deleted or its instance stops). Applied live. Tools the app lacks are
   * kept as grants but reported in `ignored` — they appear once the app
   * holds them.
   */
  async grantTools(instanceId: string, name: string, tools: string[]): Promise<SidecarToolsView & { granted: string[] }> {
    const list = SidecarManager.checkToolNames(tools);
    return this.locked(sidecarContainerName(instanceId, name), async () => {
      const { appId, sc, own } = await this.toolsTarget(instanceId, name);
      if (!own) throw SidecarManager.noOwnTools(sc);
      const consumer = `${instanceId}--${name}`;
      const before = this.readGrants(consumer);
      const granted = list.filter((t) => !before.includes(t));
      this.writeGrants(consumer, [...before, ...granted]);
      return { ...this.provisionTools(instanceId, name, appId, sc.template), granted };
    });
  }

  /** Revoke runtime grants (template tools go through the template). */
  async revokeTools(instanceId: string, name: string, tools: string[]): Promise<SidecarToolsView & { revoked: string[] }> {
    const list = SidecarManager.checkToolNames(tools);
    return this.locked(sidecarContainerName(instanceId, name), async () => {
      const { appId, sc, own } = await this.toolsTarget(instanceId, name);
      if (!own) throw SidecarManager.noOwnTools(sc);
      const consumer = `${instanceId}--${name}`;
      const before = this.readGrants(consumer);
      const templateTools = (this.opts.registry.getById(appId)?.services ?? []).find((s) => s.name === sc.template)?.tools ?? [];
      const fromTemplate = list.filter((t) => !before.includes(t) && templateTools.includes(t));
      if (fromTemplate.length) {
        throw new SpecError(409, `${fromTemplate.join(', ')} ${fromTemplate.length === 1 ? 'comes' : 'come'} from template '${sc.template}', not a runtime grant — revoke it there: aura revoke caps ${appId} ${fromTemplate.join(' ')} --template ${sc.template}`);
      }
      const revoked = before.filter((t) => list.includes(t));
      this.writeGrants(consumer, before.filter((t) => !list.includes(t)));
      return { ...this.provisionTools(instanceId, name, appId, sc.template), revoked };
    });
  }

  /**
   * Refill the own tools dir of every live OS sidecar of `instanceId` — after
   * the app's tools[] or a template's `tools` changed (the intersection may
   * have, too). Returns the sidecar names refreshed.
   */
  refreshTools(instanceId: string): string[] {
    const appId = this.opts.instance(instanceId)?.appId;
    if (!appId) return [];
    const done: string[] = [];
    for (const v of this.live.values()) {
      if (v.instanceId !== instanceId || !v.ownTools || !v.template) continue;
      try {
        this.provisionTools(instanceId, v.name, appId, v.template);
        done.push(v.name);
      } catch (err) {
        console.warn(`[SidecarManager] refresh tools of ${instanceId}--${v.name} failed: ${(err as Error).message}`);
      }
    }
    return done;
  }

  private static checkToolNames(tools: unknown): string[] {
    if (!Array.isArray(tools) || tools.length === 0 || !tools.every((t) => typeof t === 'string' && SIDECAR_TOOL_RE.test(t))) {
      throw new SpecError(400, 'tools must be a non-empty array of tool names (or \'*\')');
    }
    if (tools.includes('#')) {
      throw new SpecError(400, "'#' (all-except) is a template rule — runtime grants are plain names or '*'");
    }
    return [...new Set(tools as string[])];
  }

  private static noOwnTools(sc: OsSidecar): SpecError {
    return new SpecError(409, `${sc.containerName} has no tools of its own — declare \`tools: []\` (or a list) in its services[] template '${sc.template}' and respawn it, then grant into it`);
  }

  // ─── Remove / exec / logs ──────────────────────────────────────────────

  /** Delete an OS sidecar and every sidecar it spawned (grandchildren). */
  async remove(instanceId: string, name: string): Promise<void> {
    const container = sidecarContainerName(instanceId, name);
    await this.locked(container, async () => {
      const found = await this.inspect(container);
      if (!found || found.labels['aura.managed'] !== 'os' || found.labels['aura.parent'] !== instanceId) {
        throw new SpecError(404, `no OS sidecar '${name}' in ${instanceId}`);
      }
      const children = await dockerOk(['ps', '-aq', '--filter', 'label=aura.managed=os',
        '--filter', `label=aura.parent=${instanceId}`, '--filter', `label=aura.sidecar.owner=${name}`], 'docker ps');
      for (const child of children.split('\n').filter(Boolean)) {
        const c = await this.inspect(child);
        const childName = c?.labels['aura.service'];
        if (childName && childName !== name) await this.remove(instanceId, childName).catch(() => undefined);
      }
      this.opts.mounts.forgetConsumer(`${instanceId}--${name}`);
      await dockerOk(['rm', '-f', container], `docker rm ${container}`);
      this.forgetTools(`${instanceId}--${name}`);
      this.opts.tokens.forget(instanceId, name);
      this.untrack(instanceId, name);
      this.opts.changed?.();
    });
  }

  async exec(instanceId: string, name: string, req: ExecRequest): Promise<ExecResult> {
    if (!Array.isArray(req.cmd) || req.cmd.length === 0 || !req.cmd.every((c) => typeof c === 'string')) {
      throw new SpecError(400, 'cmd must be a non-empty array of strings');
    }
    if (req.stdin !== undefined && Buffer.byteLength(req.stdin) > MAX_STDIN) throw new SpecError(413, 'stdin is limited to 64 KiB');
    const timeoutMs = Math.min(Math.max(req.timeoutMs ?? 30_000, 1_000), 10 * 60_000);
    const sc = await this.get(instanceId, name);
    if (!sc) throw new SpecError(404, `no OS sidecar '${name}' in ${instanceId}`);
    if (sc.state !== 'running') throw new SpecError(409, `${sc.containerName} is ${sc.state}`);
    const r = await docker(['exec',
      ...(req.stdin !== undefined ? ['-i'] : []),
      ...(req.user ? ['--user', req.user] : []),
      ...(req.workdir ? ['--workdir', req.workdir] : []),
      ...Object.entries(req.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      sc.containerName, ...req.cmd], { timeoutMs, input: req.stdin });
    return { exitCode: r.timedOut ? null : r.code, stdout: r.stdout, stderr: r.stderr, truncated: r.truncated, timedOut: r.timedOut };
  }

  async logs(instanceId: string, name: string, opts: { tail?: number; since?: string; timestamps?: boolean } = {}): Promise<{ stdout: string; stderr: string }> {
    const sc = await this.get(instanceId, name);
    if (!sc) throw new SpecError(404, `no OS sidecar '${name}' in ${instanceId}`);
    const tail = Math.min(Math.max(Math.floor(opts.tail ?? 200), 1), 5000);
    const r = await docker(['logs', '--tail', String(tail),
      ...(opts.since ? ['--since', opts.since] : []),
      ...(opts.timestamps ? ['--timestamps'] : []),
      sc.containerName]);
    if (r.code !== 0) throw new Error(`docker logs ${sc.containerName}: ${r.stderr.trim()}`);
    return { stdout: r.stdout, stderr: r.stderr };
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * The instance stopped or crashed. Its containers go with `reapSiblingsOf`
   * and their binds with MountManager; only the in-memory view is ours.
   */
  removeAll(instanceId: string): void {
    for (const [key, v] of this.live) if (v.instanceId === instanceId) this.live.delete(key);
  }

  /**
   * A deliberate stop / kill: `removeAll`, plus the own tools dirs and
   * runtime tool grants of every sidecar of the instance — also the ones not
   * tracked (stopped, or never adopted). A crash only runs `removeAll`, so
   * the respawned app's sidecars get their grants back (like mount
   * declarations, see MountManager.forget vs removeAll).
   */
  forget(instanceId: string): void {
    this.removeAll(instanceId);
    const prefix = `${instanceId}--`;
    const consumers = new Set<string>();
    try {
      const runtime = dirname(dirname(this.opts.runner.toolsDir(`${prefix}x`)));
      for (const n of readdirSync(runtime)) if (n.startsWith(prefix)) consumers.add(n);
      for (const n of readdirSync(join(runtime, '.state'))) {
        if (n.startsWith(prefix) && n.endsWith('.tools.json')) consumers.add(n.slice(0, -'.tools.json'.length));
      }
    } catch { /* no runtime dir yet */ }
    for (const c of consumers) this.forgetTools(c);
  }

  /**
   * After a shell restart: re-learn every OS sidecar from docker — nonces back
   * into InstanceTokens, inheritance back into the fan-out view — and remove
   * the ones whose instance no longer exists. Run after orphan adoption and
   * BEFORE mount reconcile (which needs `liveConsumerKeys()`).
   */
  async reconcile(liveInstanceIds: Set<string>): Promise<{ adopted: number; reaped: number }> {
    let adopted = 0, reaped = 0;
    const r = await docker(['ps', '-a', '--filter', 'label=aura.managed=os',
      '--format', '{{.Names}}\t{{.Label "aura.parent"}}\t{{.Label "aura.sidecar.spec"}}']);
    if (r.code !== 0) return { adopted, reaped };
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      const [container, parent, spec] = line.split('\t') as [string, string, string];
      const rec = parseRecord(spec);
      if (!rec || !parent) continue;
      if (!liveInstanceIds.has(parent)) {
        await docker(['rm', '-f', container]);
        this.forgetTools(`${parent}--${rec.name}`);
        reaped++;
        continue;
      }
      if (rec.nonce) this.opts.tokens.register(parent, rec.nonce, rec.name);
      this.track(parent, rec.name, rec.mounts, rec);
      if (rec.ownTools) {
        // Re-provision: the app's tools[] or the template may have changed
        // while the shell was down.
        const appId = this.opts.instance(parent)?.appId;
        try { if (appId) this.provisionTools(parent, rec.name, appId, rec.template); }
        catch (err) { console.warn(`[SidecarManager] tools of ${container}: ${(err as Error).message}`); }
      }
      adopted++;
    }
    if (adopted || reaped) console.log(`[SidecarManager] reconcile: adopted ${adopted}, reaped ${reaped}`);
    return { adopted, reaped };
  }

  private track(instanceId: string, name: string, mounts: SidecarMountsView, rec?: Pick<SpecRecord, 'template' | 'ownTools'>): void {
    this.live.set(`${instanceId}--${name}`, {
      instanceId, name, mounts,
      ...(rec ? { template: rec.template, ownTools: rec.ownTools === true } : {}),
    });
  }

  private untrack(instanceId: string, name: string): void {
    this.live.delete(`${instanceId}--${name}`);
  }

  private async inspect(container: string): Promise<{ name: string; state: string; labels: Record<string, string> } | null> {
    const r = await docker(['inspect', '--format', '{{.Name}}\t{{.State.Status}}\t{{json .Config.Labels}}', container]);
    if (r.code !== 0) return null;
    const [name, state, labels] = r.stdout.trim().split('\t');
    let parsed: Record<string, string> = {};
    try { parsed = (JSON.parse(labels ?? '{}') ?? {}) as Record<string, string>; } catch { /* no labels */ }
    return { name: (name ?? container).replace(/^\//, ''), state: state ?? 'unknown', labels: parsed };
  }
}

function parseRecord(json: string | undefined): SpecRecord | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as SpecRecord;
    return typeof r.name === 'string' && typeof r.specHash === 'string' ? r : null;
  } catch { return null; }
}

function toView(containerName: string, state: string, rec: SpecRecord): OsSidecar {
  return {
    name: rec.name,
    template: rec.template,
    image: rec.image,
    containerName,
    host: containerName,
    ...(rec.port !== undefined ? { port: rec.port } : {}),
    state,
    createdAt: rec.createdAt,
    ...(rec.owner ? { owner: rec.owner } : {}),
    managedBy: 'os',
    mounts: rec.mounts,
    specHash: rec.specHash,
  };
}

/**
 * `readiness`: the sidecar is ready once `path` answers HTTP below 500 — any
 * real answer means the server is up and routing (a 401/404 on a health path
 * is still an answer); refused connections and 5xx mean not yet.
 */
async function waitForHttp(host: string, port: number, path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://${host}:${port}${path.startsWith('/') ? path : `/${path}`}`;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
      await res.body?.cancel();
      if (res.status < 500) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`${url} did not become ready within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect({ host, port });
      const done = (v: boolean) => { s.destroy(); resolve(v); };
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
      s.setTimeout(2000, () => done(false));
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`${host}:${port} did not accept connections within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
