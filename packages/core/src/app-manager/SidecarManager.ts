import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { defaultKv } from '@aura/kv-store';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import type { AppRegistry } from './AppRegistry.js';
import type { ContainerSidecarBackend } from '../runtimes/container/backends.js';
import type { RuntimeWorkloads } from '../runtimes/ari.js';
import type { InstanceTokens } from './InstanceTokens.js';
import type { FanoutTarget, MountManager } from './MountManager.js';
import type { PermissionManager } from '../permissions/PermissionManager.js';
import type { AppManifest } from '../types/manifest.js';
import type { SpawnIdentity } from '../identity/types.js';
import { listToolchainBinaries, provisionAllowlist, readAliasMap, readSidecarMap, toolchainMirrorBin } from './tool-provision.js';
import { SIDECAR_TOOL_RE, effectiveSidecarTools } from './sidecar-tools.js';
import { privateHomeSidecarRefusal } from './privateHomeNetwork.js';
import { SidecarHomeError, inheritHomeUser, isRootInstallation } from '../runtimes/spawn/identityArgs.js';
import type { ResolvedHome } from '../homes/types.js';
import { authFailureReason, isAuthFailure, parseImageRef } from '../nexus/RegistryAuth.js';
import type { PullCredential } from '../nexus/types.js';
import {
  SidecarIdentityError, SpecError, resolveSidecarSpec, sidecarPermissionError, specHash,
  type ResolvedSidecarSpec, type SidecarSpawnRequest,
} from './sidecar-spec.js';

/**
 * OS-managed sidecars: the official way for an app to run a foreign image
 * next to itself. The app asks (`POST /api/instances/:id/sidecars`, or
 * `osSidecars()` in the SDK); the OS validates the request against the app's
 * `services[]` templates and permissions (sidecar-spec.ts), and the runtime
 * that declares `workload.dynamic` realises it through its `workloads` group
 * (the container module: runtimes/container/sidecars.ts, Phase 6 D-S) — the
 * app needs no docker tool and never touches the socket. This manager keeps
 * the policy: who may act on which sidecar, the limit, tokens, tool grants,
 * mounts, seed markers and readiness.
 *
 * Every OS sidecar carries its full record with it (the runtime keeps it as
 * a tag), so a shell restart re-learns everything from the runtime
 * (reconcile); Phase 8 moves that desired state into the kernel.
 *
 * Apps that run docker themselves (SDK docker mode, raw `docker run`) keep
 * working unchanged; their containers lack `aura.managed=os`, and this
 * manager never touches them (a name collision is a 409, unless the caller
 * asks to take over its own app-managed container).
 *
 * Every runtime call is async: dynamic sidecars come in bursts, and the
 * shell's event loop serves every app at once.
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
  /** D107: on its instance's own network only; absent: the shared network. */
  network?: 'instance';
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
  /** Set when the app lacks `sidecars.tools`: nothing is provisioned. */
  needsPermission?: 'sidecars.tools';
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
  /** D107: `instance` (its instance's own network only) or `shared`. */
  network: 'instance' | 'shared';
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
  /** The kernel's storage facts (data dir, tools and mount-root dirs; A4). */
  runner: ContainerSidecarBackend;
  /** The runtime that realises OS sidecars (its `workloads` group, Phase 6 D-S); absent: none is installed. */
  workloads?: RuntimeWorkloads;
  registry: AppRegistry;
  permissions: PermissionManager;
  tokens: InstanceTokens;
  mounts: MountManager;
  /** Live instance → app + its shell-side data dir. */
  instance(instanceId: string): { appId: string; instanceDataDir: string; owner?: string; identity?: SpawnIdentity; privateHome?: boolean; runtime?: string } | null;
  /**
   * D65: the parent instance's App Home (what `inheritHome` mounts); null
   * when it can't be resolved, and the sidecar is then not created.
   */
  appHome(instanceId: string): Promise<ResolvedHome | null>;
  /**
   * Stream C: the Context keys the parent's app holds now (declared AND
   * granted) and every Context key name (`known`), for `envInherit`.
   */
  context(instanceId: string): Promise<{ env: Record<string, string>; known: Set<string> }>;
  /**
   * The registry credential `image` may be pulled with on behalf of `appId`
   * (AppManager.pullCredentialFor → nexus resolvePullCredential: only its own
   * install source's login, only inside its own artifact repository), or null
   * for an anonymous pull.
   */
  pullCredential?(appId: string, image: string): Promise<PullCredential | null>;
  /**
   * A sidecar was created or removed — lets AppManager refresh its sidecar
   * cache now instead of at the next reconciler tick (else `GET sidecars`
   * and `aura get sc` show the old state for up to a tick).
   */
  changed?(): void;
  /**
   * D107: refuses (RuntimeFeatureError, D105 shape) unless the runtime
   * isolates workloads at `level` (`requireNetworkIsolation` over the
   * registry). Asked before anything is created for an isolated sidecar.
   */
  requireNetwork?(level: 'instance'): void;
  /**
   * B12b: whether the app's current installation holds
   * `home.inherit.sidecar:<template>` (GrantStore, pinned). Absent or failing:
   * not granted, so a root installation's home sidecar is refused.
   */
  homeInheritGranted?(appId: string, template: string): Promise<boolean>;
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
/** Readiness waits ask the runtime whether the sidecar is still up on every Nth failed probe. */
const UP_CHECK_EVERY = 4;

/**
 * A registry refused a sidecar image pull (`code: 'image_auth'`). Fails the
 * spawn closed with the way out; the message carries the registry's words,
 * never a credential.
 */
export class ImageAuthError extends SpecError {
  readonly code = 'image_auth';
  constructor(readonly image: string, detail: string, cred: PullCredential | null, reason: 'rejected' | 'missing' | 'forbidden') {
    const { host } = parseImageRef(image);
    super(502, !cred
      ? `image_auth: ${host} refused the pull of ${image} without a login (${detail}). A private image is pulled with the registry login of the Nexus source the app was installed from, and only when it lives inside the app's own repository there (e.g. <app repository>/runtime); other sources' logins and other repositories are never used. Set that source's login: aura nexus registry login <source>`
      : reason === 'forbidden'
        ? `image_auth: the login of Nexus source '${cred.source}' may not read ${host}/${cred.repository} (${detail}). Give its token read access to that repository (GitLab: a deploy token with the read_registry scope on the project or group), then set it: aura nexus registry login ${cred.source}`
        : `image_auth: ${host} rejected the login of Nexus source '${cred.source}' for ${cred.repository} (${detail}). Check or renew it (GitLab: a deploy token with read_registry): aura nexus registry login ${cred.source}`);
    this.name = 'ImageAuthError';
  }
}

export class SidecarManager {
  /** consumerKey → what fan-out (and tool refresh) needs about each live OS sidecar. */
  private live = new Map<string, { instanceId: string; name: string; mounts: SidecarMountsView; template?: string; ownTools?: boolean }>();
  private locks = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: SidecarManagerOpts) {}

  /** The runtime's `workloads` group; refused explicitly without one (never a silent no-op). */
  private wl(): RuntimeWorkloads {
    if (!this.opts.workloads) throw new SpecError(501, 'capability-missing: sidecars (no installed runtime runs OS sidecars)');
    return this.opts.workloads;
  }

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

  /** A sidecar outside its own subtree: the app's `sidecars.manageAll` would lift it (D105 Pass B). */
  private manageAllRefusal(instanceId: string, message: string): SpecError {
    const appId = this.opts.instance(instanceId)?.appId;
    return appId ? sidecarPermissionError(appId, 'sidecars.manageAll', message) : new SpecError(403, message);
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
      throw this.manageAllRefusal(instanceId, `sidecar '${caller!.sidecar}' may only manage the sidecars it spawned — '${name}' is not one of them (the app's permission sidecars.manageAll lifts this)`);
    }
  }

  // ─── Queries ───────────────────────────────────────────────────────────

  /**
   * OS sidecars of an instance, straight from the runtime. With a sidecar `caller`
   * only what it may manage (see authorize).
   */
  async list(instanceId: string, caller?: Caller): Promise<OsSidecar[]> {
    const all = await this.listAll(instanceId);
    if (this.mayManageAll(instanceId, caller)) return all;
    return all.filter((s) => SidecarManager.descends(all, s.name, caller!.sidecar!));
  }

  private async listAll(instanceId: string): Promise<OsSidecar[]> {
    return (await this.wl().listOf(instanceId)).flatMap((w) => {
      const rec = parseRecord(w.record);
      return rec ? [toView(w.ref, w.state ?? 'unknown', rec)] : [];
    });
  }

  async get(instanceId: string, name: string): Promise<OsSidecar | null> {
    const found = await this.inspect(this.wl().ref(instanceId, name));
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

  async spawn(instanceId: string, req: SidecarSpawnRequest, caller: Caller): Promise<{ created: boolean; sidecar: OsSidecar; tools?: { effective: string[]; ignored: string[] } }> {
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
      if (await this.wl().storageExists(name)) legacy.add(name);
    }
    const spec = resolveSidecarSpec(req, {
      appId: inst.appId,
      instanceId,
      manifest,
      can: (p) => this.opts.permissions.hasPermission(inst.appId, p),
      appDataSubpath,
      appDataVolume: rt.appDataVolume,
      legacyVolumeExists: (n) => legacy.has(n),
    });
    // B12: an inheritHome sidecar runs as its app's identity; a conflicting template user is refused (D105).
    const appUser = spec.inheritHome ? inheritHomeUser(inst.identity) : null;
    if (appUser !== null && spec.user !== undefined && spec.user !== appUser) {
      throw new SidecarIdentityError(inst.appId, spec.template, spec.user, appUser);
    }
    // B12b (owner decision 7): a root installation's home sidecar only with the owner's explicit grant
    // for this template and installation (b); the runtime then verifies a non-root user (a) and that
    // it can't escalate (c), else refuses (identityArgs SidecarHomeError). Never implicit.
    const rootHome = !!spec.inheritHome && isRootInstallation(inst.identity);
    if (rootHome) {
      const granted = await this.opts.homeInheritGranted?.(inst.appId, spec.template).catch(() => false);
      if (granted !== true) throw SidecarHomeError.notAuthorized(inst.appId, spec.template);
    }
    // D107: mandatory isolation, refused before anything is made when the runtime can't enforce it.
    if (spec.network === 'instance') this.opts.requireNetwork?.('instance');
    // D107 / D9: a parent with a Private Home: none of its sidecars on the shared network (privateHomeNetwork.ts).
    if (inst.privateHome) {
      const refusal = privateHomeSidecarRefusal(inst.runtime ?? 'unknown', inst.appId, spec.name, spec.network ?? 'shared');
      if (refusal) throw refusal;
    }
    const hash = specHash(spec);
    const container = this.wl().ref(instanceId, spec.name);
    // Spawn-time tools = initial runtime grants (resolveSidecarSpec already
    // required sidecars.tools and a template with `tools`).
    const spawnTools = req.tools?.length ? SidecarManager.checkToolNames(req.tools) : [];
    const consumerKey = `${instanceId}--${spec.name}`;
    const templateTools = (manifest.services ?? []).find((s) => s.name === spec.template)?.tools ?? [];
    /** Merge the spawn-time tools into the runtime grants; returns an undo. */
    const grantSpawnTools = (): (() => void) => {
      const add = spawnTools.filter((t) => !templateTools.includes(t));   // the template already grants those
      if (!add.length) return () => undefined;
      const before = this.readGrants(consumerKey);
      this.writeGrants(consumerKey, [...before, ...add.filter((t) => !before.includes(t))]);
      return () => this.writeGrants(consumerKey, before);
    };
    const toolsOut = (v: SidecarToolsView) => ({ tools: { effective: v.effective, ignored: v.ignored } });

    // The lock covers deciding and creating only. Waiting for readiness happens
    // after it, so a sidecar that never comes up (or crash-loops) cannot hold
    // back every later spawn or remove of the same name for the whole timeout.
    const out = await this.locked(container, async () => {
      const existing = await this.inspect(container);
      // A sidecar may (re)spawn only within its own subtree: a name that is
      // already someone else's is not its to replace.
      if (existing && !this.mayManageAll(instanceId, caller)
        && !(existing.labels['aura.managed'] === 'os' && SidecarManager.descends(await this.listAll(instanceId), spec.name, caller.sidecar!))) {
        throw this.manageAllRefusal(instanceId, `sidecar '${caller.sidecar}' may not replace '${spec.name}' — it did not spawn it (the app's permission sidecars.manageAll lifts this)`);
      }
      if (existing) {
        const managed = existing.labels['aura.managed'] === 'os';
        if (!managed) {
          if (!(req.takeover && existing.labels['aura.parent'] === instanceId)) {
            throw new SpecError(409, `${container} exists but is not OS-managed (the app runs it itself) — pass takeover: true to replace your own app-managed container`);
          }
        } else {
          const rec = parseRecord(existing.labels['aura.sidecar.spec']);
          // B12b: a root installation's home sidecar is never adopted (one made before B12b skipped its checks):
          // it is recreated, and the runtime's create checks (a) and (c) again.
          if (rec && rec.specHash === hash && existing.state === 'running' && !rootHome) {
            // Same spec, already up: adopt. Re-learn its nonce and make sure its
            // mounts are there (idempotent — present ones are skipped).
            if (rec.nonce) this.opts.tokens.register(instanceId, rec.nonce, spec.name);
            // D107: a restarted instance's container rejoins its workload network before it calls the sidecar.
            if (rec.network === 'instance') await this.wl().attachInstance(instanceId);
            this.track(instanceId, spec.name, rec.mounts, rec);
            let tools: SidecarToolsView | null = null;
            if (rec.ownTools) {
              grantSpawnTools();   // merged into what the running sidecar already has
              tools = this.provisionTools(instanceId, spec.name, inst.appId, spec.template);
            }
            if (rec.mounts.own || rec.mounts.inherit) {
              await this.opts.mounts.reapplyConsumer(`${instanceId}--${spec.name}`, rec.mounts);
            }
            return { created: false, sidecar: toView(container, existing.state, rec), ...(tools ? toolsOut(tools) : {}) };
          }
          if (rec && rec.specHash !== hash && req.replace === false) {
            throw new SpecError(409, `${container} runs a different spec — pass replace: true (the default) to recreate it`);
          }
        }
        // Recreate. Own mount declarations stay; the binds go with the container.
        this.opts.mounts.removeAll(`${instanceId}--${spec.name}`);
        await this.wl().destroy(container);
        this.untrack(instanceId, spec.name);
      } else {
        // Running ones only — a stopped sidecar holds a name, not resources.
        const running = (await this.listAll(instanceId)).filter((x) => x.state === 'running').length;
        const limit = await sidecarLimit();
        if (running >= limit) {
          throw new SpecError(429, `${instanceId} already runs ${running} OS sidecars (limit ${limit} — OS setting os:sidecars.maxPerInstance)`);
        }
      }

      await this.ensureImage(spec.image, inst.appId);
      for (const v of spec.volumes) if (v.subpath) mkdirSync(join(rt.dataDir, v.subpath), { recursive: true });
      const wantsMountRoot = spec.mounts.own || spec.mounts.inherit;
      const consumer = `${instanceId}--${spec.name}`;
      if (wantsMountRoot) mkdirSync(this.opts.runner.mountRootDir(consumer), { recursive: true });
      // Own tools are in place before the container starts (the dir is
      // mounted by inode — it must exist, and the first exec must find them).
      const undoTools = spec.ownTools ? grantSpawnTools() : () => undefined;
      const tools = spec.ownTools ? this.provisionTools(instanceId, spec.name, inst.appId, spec.template) : null;

      const env = await this.environment(instanceId, inst.appId, spec);
      if (spec.seed) await this.seed(instanceId, spec, appDataSubpath, env);

      // The sidecar acts for the instance's owner (5.8).
      const token = spec.inheritIdentity ? this.opts.tokens.mint(instanceId, spec.name, inst.owner) : null;
      const record: SpecRecord = {
        name: spec.name, template: spec.template, image: spec.image, specHash: hash,
        ...(token ? { nonce: token.nonce } : {}),
        ...(spec.port !== undefined ? { port: spec.port } : {}),
        mounts: spec.mounts,
        ...(caller.sidecar ? { owner: caller.sidecar } : {}),
        ...(spec.ownTools ? { ownTools: true as const } : {}),
        ...(spec.network ? { network: spec.network } : {}),
        createdAt: new Date().toISOString(),
      };
      // inheritHome: the parent's App Home (D65), the one its app process has; never a Private Home.
      let home: ResolvedHome | null = null;
      if (spec.inheritHome) {
        home = await this.opts.appHome(instanceId);
        if (!home || home.kind === 'private') throw new Error(`sidecar ${spec.name}: the app's home can't be resolved, so inheritHome has nothing to mount; not created`);
      }
      const permissions = this.opts.registry.getById(inst.appId)?.permissions;
      const parentIdentity = this.opts.instance(instanceId)?.identity;
      // A refused create (B12b: the runtime's identity checks) leaves no token or tool grant behind.
      const id = await this.wl().create({
        instanceId, appId: inst.appId, spec, record: JSON.stringify(record), ...(record.owner ? { owner: record.owner } : {}),
        env, token: token?.token ?? null, home,
        ...(parentIdentity ? { parentIdentity } : {}),
        ...(permissions ? { permissions } : {}),
      }).catch((err: unknown) => {
        if (token) this.opts.tokens.forget(instanceId, spec.name);
        undoTools();
        throw err;
      });
      // Started and up, or removed again with its own words (a failed start, a runtime that dies on boot).
      try {
        await this.wl().start(id, container);
      } catch (err) {
        if (token) this.opts.tokens.forget(instanceId, spec.name);
        undoTools();
        throw err;
      }

      this.track(instanceId, spec.name, spec.mounts, record);
      this.opts.changed?.();
      if (wantsMountRoot) await this.opts.mounts.reapplyConsumer(consumer, spec.mounts);
      return { created: true, sidecar: toView(container, 'running', record), ...(tools ? toolsOut(tools) : {}) };
    });
    // An adopted sidecar may still be starting (a concurrent spawn created it),
    // so a caller that asked to wait waits in both cases.
    if (spec.port && (req.wait?.ready || req.wait?.port)) {
      const up = await this.upProbe(container);
      if (req.wait.ready && spec.readiness) {
        await waitForHttp(container, spec.port, spec.readiness.path, req.wait.timeoutMs ?? spec.readiness.timeoutMs, up);
      } else {
        await waitForPort(container, spec.port, req.wait.timeoutMs ?? 60_000, up);
      }
    }
    return out;
  }

  /**
   * A check for the readiness waits: throws once the container is gone, no
   * longer running, or has restarted since the wait began. A crash-looping
   * runtime then fails the spawn within seconds, with its own last words,
   * instead of only at the readiness timeout.
   */
  private async upProbe(container: string): Promise<() => Promise<void>> {
    const restartsAtStart = (await this.inspect(container))?.restarts ?? 0;
    return async () => {
      const now = await this.inspect(container);
      if (!now) throw new Error(`${container} was removed before it became ready`);
      if (now.state === 'running' && now.restarts <= restartsAtStart) return;
      const words = await this.wl().lastWords(container);
      const how = now.state === 'running' ? `restarted ${now.restarts - restartsAtStart} time(s)` : `is ${now.state}`;
      throw new Error(`${container} ${how} before it became ready:\n${words || '(no output)'}`);
    };
  }

  /**
   * Make `image` present through the runtime (its `workloads.prepareImage`).
   * With a credential for it (opts.pullCredential, asked only when the image
   * is missing) the runtime pulls with a throwaway auth file holding only that
   * login, removed in every case; the secret is never in argv, the env, a log
   * or an error, and never reaches the app or the sidecar. A refused pull is
   * an ImageAuthError (`image_auth`): the kernel classifies the runtime's
   * (redacted) words.
   */
  private async ensureImage(image: string, appId: string): Promise<void> {
    let cred: PullCredential | null = null;
    try {
      await this.wl().prepareImage(image, async () => {
        try { cred = (await this.opts.pullCredential?.(appId, image)) ?? null; }
        catch (err) { console.warn(`[SidecarManager] no registry credential for ${image} (${appId}), pulling anonymously: ${(err as Error).message}`); }
        return cred;
      });
    } catch (err) {
      const out = (err as { output?: unknown }).output;
      if (typeof out === 'string' && isAuthFailure(out)) {
        throw new ImageAuthError(image, out.split('\n').pop()!.slice(-300), cred, authFailureReason(out, !!cred));
      }
      throw err;
    }
  }

  /**
   * Env from envInherit, then the spec's own. A Context key comes only from
   * the parent's granted keys (stream C: a sidecar never sees more than its
   * app); any other name from the app container's env.
   */
  private async environment(instanceId: string, appId: string, spec: ResolvedSidecarSpec): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    if (spec.envInherit.length) {
      const ctx = await this.opts.context(instanceId).catch(() => ({ env: {} as Record<string, string>, known: null }));
      let parentEnv: Record<string, string> | null = null;
      for (const name of spec.envInherit) {
        if (ctx.env[name] !== undefined) { env[name] = ctx.env[name]; continue; }
        // A Context key the app does not hold, or names unknown (Valkey down): never from the container's env.
        if (!ctx.known || ctx.known.has(name)) continue;
        parentEnv ??= await this.wl().instanceEnv(instanceId);
        if (parentEnv[name] !== undefined) env[name] = parentEnv[name];
      }
    }
    void appId;
    return { ...env, ...spec.env };
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
    await this.wl().seed({ instanceId, spec, env });
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
        await this.ensureImage(svc.image, manifest.id);
      } catch (err) {
        console.warn(`[SidecarManager] prePull ${svc.image} for ${manifest.id} failed: ${(err as Error).message}`);
      }
    }
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
      listToolchainBinaries(store), readSidecarMap(store), readAliasMap(store));
    // Never hand tools to a sidecar of an app without sidecars.tools — also
    // not on adopt / reconcile / refresh after the permission was revoked:
    // the dir is emptied (in place) instead.
    const permitted = this.opts.permissions.hasPermission(appId, 'sidecars.tools');
    if (!permitted) r.effective = [];
    if (apply) {
      provisionAllowlist({ dataDir, dir: this.opts.runner.toolsDir(consumer), tools: r.effective, legacyStoreBin: store });
    }
    return { own: true, inherited: false, template: templateTools, runtime, ...r, ...(permitted ? {} : { needsPermission: 'sidecars.tools' as const }) };
  }

  private provisionTools(instanceId: string, name: string, appId: string, template: string): SidecarToolsView {
    return this.computeTools(instanceId, name, appId, template, true);
  }

  /** The sidecar and its app, or 404. */
  private async toolsTarget(instanceId: string, name: string): Promise<{ appId: string; sc: OsSidecar; own: boolean }> {
    const appId = this.opts.instance(instanceId)?.appId;
    if (!appId) throw new SpecError(404, `Instance not found: ${instanceId}`);
    const found = await this.inspect(this.wl().ref(instanceId, name));
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
    return this.locked(this.wl().ref(instanceId, name), async () => {
      const { appId, sc, own } = await this.toolsTarget(instanceId, name);
      if (!this.opts.permissions.hasPermission(appId, 'sidecars.tools')) {
        throw sidecarPermissionError(appId, 'sidecars.tools', `${appId} is not granted 'sidecars.tools' (aura grant perms ${appId} sidecars.tools)`);
      }
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
    return this.locked(this.wl().ref(instanceId, name), async () => {
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
    const container = this.wl().ref(instanceId, name);
    await this.locked(container, async () => {
      const found = await this.inspect(container);
      if (!found || found.labels['aura.managed'] !== 'os' || found.labels['aura.parent'] !== instanceId) {
        throw new SpecError(404, `no OS sidecar '${name}' in ${instanceId}`);
      }
      for (const child of await this.wl().spawnedBy(instanceId, name)) {
        const c = await this.inspect(child);
        const childName = c?.labels['aura.service'];
        if (childName && childName !== name) await this.remove(instanceId, childName).catch(() => undefined);
      }
      this.opts.mounts.forgetConsumer(`${instanceId}--${name}`);
      await this.wl().destroy(container);
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
    return this.wl().run(sc.containerName, {
      argv: req.cmd, timeoutMs,
      ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
      ...(req.user ? { user: req.user } : {}),
      ...(req.workdir ? { workdir: req.workdir } : {}),
      ...(req.env ? { env: req.env } : {}),
    });
  }

  async logs(instanceId: string, name: string, opts: { tail?: number; since?: string; timestamps?: boolean } = {}): Promise<{ stdout: string; stderr: string }> {
    const sc = await this.get(instanceId, name);
    if (!sc) throw new SpecError(404, `no OS sidecar '${name}' in ${instanceId}`);
    const tail = Math.min(Math.max(Math.floor(opts.tail ?? 200), 1), 5000);
    return this.wl().output(sc.containerName, {
      tail, ...(opts.since ? { since: opts.since } : {}), ...(opts.timestamps ? { timestamps: true } : {}),
    });
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
   * After a shell restart: re-learn every OS sidecar from its runtime — nonces back
   * into InstanceTokens, inheritance back into the fan-out view — and remove
   * the ones whose instance no longer exists. Run after orphan adoption and
   * BEFORE mount reconcile (which needs `liveConsumerKeys()`).
   */
  async reconcile(liveInstanceIds: Set<string>): Promise<{ adopted: number; reaped: number }> {
    let adopted = 0, reaped = 0;
    const managed = await this.wl().listManaged();
    if (!managed) return { adopted, reaped };
    for (const { ref: container, instanceId: parent, record } of managed) {
      const rec = parseRecord(record);
      if (!rec || !parent) continue;
      if (!liveInstanceIds.has(parent)) {
        await this.wl().destroy(container, { quiet: true });
        this.forgetTools(`${parent}--${rec.name}`);
        reaped++;
        continue;
      }
      if (rec.nonce) this.opts.tokens.register(parent, rec.nonce, rec.name);
      this.track(parent, rec.name, rec.mounts, rec);
      if (rec.network === 'instance') {
        try { await this.wl().attachInstance(parent); }
        catch (err) { console.warn(`[SidecarManager] ${container}: its instance can't rejoin the instance network: ${(err as Error).message}`); }
      }
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

  /** The workload as its runtime reports it: its name, state, tags (labels) and restarts. */
  private async inspect(container: string): Promise<{ name: string; state: string; labels: Record<string, string>; restarts: number } | null> {
    const w = await this.wl().inspect(container);
    return w ? { name: w.ref, state: w.state, labels: w.tags, restarts: w.restarts } : null;
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
    network: rec.network ?? 'shared',
    specHash: rec.specHash,
  };
}

/**
 * `readiness`: the sidecar is ready once `path` answers HTTP below 500 — any
 * real answer means the server is up and routing (a 401/404 on a health path
 * is still an answer); refused connections and 5xx mean not yet.
 */
async function waitForHttp(host: string, port: number, path: string, timeoutMs: number, up: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://${host}:${port}${path.startsWith('/') ? path : `/${path}`}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
      await res.body?.cancel();
      if (res.status < 500) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`${url} did not become ready within ${timeoutMs} ms`);
    if (attempt % UP_CHECK_EVERY === 0) await up();
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function waitForPort(host: string, port: number, timeoutMs: number, up: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect({ host, port });
      const done = (v: boolean) => { s.destroy(); resolve(v); };
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
      s.setTimeout(2000, () => done(false));
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`${host}:${port} did not accept connections within ${timeoutMs} ms`);
    if (attempt % UP_CHECK_EVERY === 0) await up();
    await new Promise((r) => setTimeout(r, 300));
  }
}
