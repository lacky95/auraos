/**
 * Cross-app filesystem mounting — attach another app's directory into an
 * ALREADY-RUNNING app container, with no restart.
 *
 * ## How it works
 *
 * Docker cannot add a mount to a running container, so we go under it and use
 * Linux mount propagation. Every app container's `/data` is a
 * `--mount type=volume,volume-subpath=…` of the shared app-data volume, and
 * docker leaves those as SLAVE mounts (`master:N`) of the host's peer group.
 * A slave receives propagation. So a host-side `mount --bind` landing anywhere
 * under the instance's data dir appears inside the running container
 * immediately, at native speed, with no `nsenter` into the app and no FUSE.
 *
 * We mount at `<instanceDataDir>/.mnt/<targetAppId>`, which surfaces inside the
 * consumer as `/data/.mnt/<targetAppId>`.
 *
 * ## Read-only is NOT `remount,ro`
 *
 * Mount-attribute changes do not propagate to peers/slaves: `mount --bind`
 * followed by `mount -o remount,ro,bind` leaves the container seeing a WRITABLE
 * mount (measured — a probe write reached the target app's real source).
 * `mount --bind -o ro` also fails on util-linux 2.38 (classic API fallback).
 *
 * What works is binding from a source that is ALREADY read-only: the kernel
 * refuses to make a bind of a locked read-only mount more permissive, and the
 * `ro` attribute is therefore present at propagation time. So the helper mounts
 * the source with `:ro` and does a plain bind. Verified: container sees
 * `ro,relatime`, writes fail with `Read-only file system`.
 *
 * Because a silent ro→rw downgrade would hand out a filesystem boundary that
 * doesn't exist, every mount is VERIFIED after the fact against the target
 * container's own `/proc/self/mountinfo`, and rolled back if it doesn't match.
 *
 * ## Sidecars as consumers
 *
 * An OS-managed sidecar (SidecarManager) is a consumer too, keyed
 * `<instanceId>--<sidecar>`. App ids carry no `-` and sidecar names are
 * kebab-case, so the key is unambiguous, and every path rule falls out of it:
 * container `aura-<inst>--<sc>`, mount root `aura/mounts/<inst>--<sc>`.
 * A sidecar has two kinds of mounts:
 *  - its OWN, added through the API — declared and persisted like an app's;
 *  - INHERITED from its app (`inheritMounts`), mirrored by fan-out whenever
 *    the app's set changes — never persisted, always derived from the app's.
 * Sidecars never use the legacy `/data/.mnt` root.
 *
 * ## Closed sources and patch workspaces (Track P)
 *
 * A closed install's source (nexus/AppSource.ts `effectiveSourceMode`) is
 * mounted read-only only: a writable request is refused, and a writable
 * declaration or re-bind of it comes back read-only. Changes go through a
 * patch workspace instead: a `work` mount binds a writable dir of the
 * app-data volume (`aura/workspaces/<userId>/<installationId>/<n>`) at
 * `/mnt/aura/work/<appId>` of the one consumer that asked for it. The patch
 * repository of an installation is one dir of the volume too
 * (`aura/patches/<installationId>`), bound writable at
 * `/mnt/aura/patches/<appId>` (a `patches` mount): every Terminal of every
 * user who patches that installation sees the same series, and it outlives
 * them. Neither follows the app's directory or is mirrored into sidecars.
 *
 * Known limit: a consumer holding the Docker socket (the System Terminal)
 * can bind anything itself. Until Phase 5 removes the socket (D30),
 * read-only here is a guardrail for agents, not a boundary.
 *
 * ## Between different uids (D80, 5b G)
 *
 * Since per-installation app uids, a writable `source` or `data` mount into a
 * consumer that runs as another uid than the files' on-disk owner would be
 * writable in name only. Such a mount is an idmapped bind (the session
 * launcher's `idmap-bind`, run in the helper): the owner shows as the
 * consumer inside the bind only, writes land as the owner on disk, and the
 * bind is nosuid,nodev. It needs the runtime's `idmappedMounts` (a boot
 * probe) and is refused with `capability-missing: idmappedMounts` otherwise,
 * never made read-only or broader. A source tree (root-owned) needs
 * Developer Mode on top of being open; a root-owned data tree is never
 * mapped. Switching Developer Mode off, or revoking `apps.mount`, makes such
 * mounts read-only again (`revokeWritable`). Read-only mounts are unchanged.
 *
 * ## The AuraOS checkout (`workspace` kind, Developer Mode)
 *
 * `aura mount workspace` binds `/workspace`, the live AuraOS source,
 * read-write at `/mnt/aura/workspace` of one System Terminal instance (D60).
 * Who may ask, and only in Developer Mode, is the shell route's decision; here
 * it is just a mount that is never declared (it ends with the instance, or
 * when Developer Mode is switched off), never mirrored into sidecars and
 * never made into a sidecar.
 */
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppRegistry } from './AppRegistry.js';
import type { ScopeRegistry } from '../scopes/ScopeRegistry.js';
import { IDMAP_HELPER_PATH, type ContainerMountBackend } from '../runtimes/container/backends.js';
import { containerName } from '../runtimes/container/names.js';
import { RuntimeCapabilityError } from '../runtimes/types.js';
import { BASE_IMAGE } from './BaseImage.js';
import { SYSTEM_APP_LATER, SYSTEM_APP_LATER_MESSAGE } from '../nexus/AppSource.js';

const HELPER_IMAGE = BASE_IMAGE;
/**
 * Canonical mount root inside a consumer container. Provisioned at spawn by
 * `ContainerRunner`, so only containers started since that change have it.
 */
export const MOUNT_ROOT_PATH = '/mnt/aura';
/**
 * Legacy root, relative to the consumer's own `/data`. Every container has a
 * `/data` volume mount regardless of age, and docker leaves it a slave of the
 * host peer group — so this works on containers spawned before `/mnt/aura`
 * existed. Kept permanently as the fallback rather than as a migration step.
 */
export const MOUNT_DIR_NAME = '.mnt';

export type MountMode = 'ro' | 'rw';
export type MountKind = 'source' | 'data' | 'work' | 'patches' | 'workspace';
/** Id (and mount dir name) of the `workspace` kind. App ids always contain a dot, so it never names an app. */
export const WORKSPACE_MOUNT_ID = 'workspace';
/** The AuraOS checkout, as the shell sees it. */
const WORKSPACE_DIR = '/workspace';

/** Where `work` mounts appear under a consumer's mount root. */
export const WORK_DIR_NAME = 'work';
/** Where `patches` mounts appear under a consumer's mount root. */
export const PATCHES_DIR_NAME = 'patches';
const PATCHES_SUBPATH = /^aura\/patches\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/**
 * What each mount kind does (F11): one table instead of kind checks spread
 * through the manager. A new kind is a new row.
 */
export interface MountKindPolicy {
  /** Written to the consumer's declarations and restored at its next spawn. */
  persist: boolean;
  /** A live add or remove is mirrored into the consumer's inheriting sidecars. */
  fanout: boolean;
  /** Mirrored into an inheriting sidecar when the sidecar starts (`reapply` with `inherit`). */
  inheritToSidecar: boolean;
  /** Re-made when the target app's directory is replaced (reinstall, update). */
  rebindOnReinstall: boolean;
  /** `requested`: the asked mode, read-only by default. `always-rw`: a dir the consumer alone writes. */
  modeRule: 'requested' | 'always-rw';
  /** Needs the consumer's mount root at MOUNT_ROOT_PATH (a container consumer). */
  needsMountRoot: boolean;
  /** The source dir is created when missing (it appears only later, or is the consumer's own). */
  createsSource: boolean;
  /** A built-in (system scope) app may be the target. Built-in apps stay read-only (Q6). */
  builtInTargets: boolean;
}

export const KIND_POLICY: Readonly<Record<MountKind, Readonly<MountKindPolicy>>> = Object.freeze({
  source:    { persist: true,  fanout: true,  inheritToSidecar: true,  rebindOnReinstall: true,  modeRule: 'requested', needsMountRoot: false, createsSource: false, builtInTargets: true },
  data:      { persist: true,  fanout: true,  inheritToSidecar: true,  rebindOnReinstall: true,  modeRule: 'requested', needsMountRoot: false, createsSource: true,  builtInTargets: true },
  // A patch workspace or patch repo: a writable dir of the app-data volume,
  // owned by the consumer alone. It does not live in the target app's dir.
  // (`inheritToSidecar` is today's behaviour of `reapply`; `fanout` is not.)
  work:      { persist: true,  fanout: false, inheritToSidecar: true,  rebindOnReinstall: false, modeRule: 'always-rw', needsMountRoot: true,  createsSource: true,  builtInTargets: false },
  patches:   { persist: true,  fanout: false, inheritToSidecar: true,  rebindOnReinstall: false, modeRule: 'always-rw', needsMountRoot: true,  createsSource: true,  builtInTargets: false },
  // The AuraOS checkout (Developer Mode): lives as long as the instance or
  // Developer Mode, never declared, never mirrored.
  workspace: { persist: false, fanout: false, inheritToSidecar: false, rebindOnReinstall: false, modeRule: 'always-rw', needsMountRoot: true,  createsSource: false, builtInTargets: true },
});
const WORKSPACE_SUBPATH = /^aura\/workspaces\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[1-9]\d{0,3}$/;
/**
 * How a mount came to exist in this shell generation:
 *  - `added`    — attached via the API (`aura mount add`) in this life of the instance
 *  - `restored` — re-applied from a persisted declaration after a (re)spawn
 *  - `adopted`  — found live in the kernel after a shell restart
 *  - `inherited` — mirrored from the parent app into an OS sidecar (fan-out)
 */
export type MountOrigin = 'added' | 'restored' | 'adopted' | 'inherited';

/** Separator of a sidecar consumer key: `<instanceId>--<sidecar>`. */
const SIDECAR_SEP = '--';

/** Is this consumer key an OS sidecar (`<instanceId>--<sidecar>`)? */
export function isSidecarConsumer(key: string): boolean {
  return key.includes(SIDECAR_SEP);
}

/** The instance a consumer key belongs to (itself for an app instance). */
export function parentOfConsumer(key: string): string {
  const i = key.indexOf(SIDECAR_SEP);
  return i === -1 ? key : key.slice(0, i);
}

/** How a sidecar consumer mirrors its app's mounts. */
export interface FanoutTarget {
  /** `<instanceId>--<sidecar>`. */
  consumer: string;
  /** Parent mount ids NOT mirrored. */
  exclude: string[];
  /** Mirror every mount read-only, whatever the parent has. */
  forceRo: boolean;
}

export interface AuraMount {
  /** `<targetAppId>` for a source mount, `<targetAppId>:data` for a data mount, `workspace` for the checkout. */
  id: string;
  /** The CONSUMER — the instance the files are mounted INTO. */
  instanceId: string;
  /** The mounted app; `workspace` for the AuraOS checkout. */
  targetAppId: string;
  kind: MountKind;
  mode: MountMode;
  /** Where it appears inside the consumer container. */
  containerPath: string;
  /** Daemon-visible source path that was bound. */
  hostSource: string;
  /** Daemon-visible destination path. */
  hostDest: string;
  createdAt: string;
  origin: MountOrigin;
  /** When the user first ASKED for this mount — survives restores, so a
   *  restored mount dated long before the instance started stands out. */
  declaredAt: string;
  /** Set on `inherited` mounts: the instance the mount was mirrored from. */
  inheritedFrom?: string;
  /** `work` mounts: the workspace dir, relative to the root dataDir. */
  workspace?: string;
  /** `patches` mounts: the patch repository dir, relative to the root dataDir. */
  patches?: string;
  /**
   * D80: a writable mount between different uids, through an idmapped bind:
   * the on-disk owner (`from`, `uid:gid`) shows as the consumer (`to`) inside
   * the bind only.
   */
  idmap?: { from: string; to: string };
}

export interface AddMountSpec {
  targetAppId: string;
  mode?: MountMode;
  /** Mount the target's DATA dir instead of its source. */
  data?: boolean;
  /** Persisted with the declaration; absent on API requests and old files. */
  declaredAt?: string;
  /**
   * A patch workspace of the target app, relative to the root dataDir
   * (`aura/workspaces/<userId>/<installationId>/<n>`): a `work` mount,
   * always writable. Excludes `data`.
   */
  workspace?: string;
  /**
   * The patch repository of an installation, relative to the root dataDir
   * (`aura/patches/<installationId>`): a `patches` mount, always writable.
   */
  patches?: string;
}

interface MountManagerOpts {
  dataDir: string;
  registry: AppRegistry;
  scopeRegistry: ScopeRegistry;
  runner: ContainerMountBackend;
  /**
   * D80: the `uid:gid` a consumer's processes run as; null for a root
   * consumer that keeps its capabilities (it writes anywhere). Absent: no
   * cross-uid handling (tests, a host without app identities).
   */
  consumerIdentity?(consumer: string): { uid: number; gid: number } | null;
  /** D80: Developer Mode is on (a writable source mount into another uid needs it). Absent: off. */
  developerMode?(): boolean;
  /** The consumer's runtime id, for a capability refusal. */
  runtimeOf?(consumer: string): string | undefined;
  /** Resolve a consumer instanceId → its shell-side data dir. */
  instanceDataDir(instanceId: string): string | null;
  /**
   * Live OS sidecars of an instance that mirror its mounts. Supplied by
   * SidecarManager; absent → no fan-out.
   */
  fanoutTargets?(instanceId: string): FanoutTarget[];
  /** The target app's effective source mode; absent → every source is open. */
  sourceMode?(targetAppId: string): 'closed' | 'open';
}

export class MountManager {
  /** instanceId → mountId → mount. Authoritative state is the kernel; this is a cache. */
  private mounts = new Map<string, Map<string, AuraMount>>();
  /** Background fan-out work, awaited by `settled()` (tests, e2e). */
  private fanout: Promise<void> = Promise.resolve();

  constructor(private readonly opts: MountManagerOpts) {}

  // ─── Declarations ──────────────────────────────────────────────────────
  //
  // The kernel is authoritative for what IS mounted, but it can't answer what
  // the user ASKED FOR: binds are reaped whenever an instance stops (a leaked
  // bind pins the source filesystem), and a container created afterwards does
  // NOT inherit binds that already exist under its mount root — docker's volume
  // mount is a non-recursive bind, so only containers that were running at
  // add-time receive propagation. Without a durable record, every mount
  // silently evaporated on the next restart while `aura mount ls` kept
  // reporting it.
  //
  // So the DECLARATION is persisted next to (not inside) the mount root, and
  // re-applied by `reapply()` once the container is up again.

  private declFile(instanceId: string): string {
    return join(this.opts.dataDir, 'aura', 'mounts', '.state', `${instanceId}.json`);
  }

  private readDecls(instanceId: string): AddMountSpec[] {
    try {
      const raw = JSON.parse(readFileSync(this.declFile(instanceId), 'utf-8')) as unknown;
      return Array.isArray(raw) ? raw as AddMountSpec[] : [];
    } catch { return []; }   // absent or corrupt — nothing declared
  }

  /** Persist the current mount set as declarations. Never throws: a failed
   *  write must not fail the mount the user just asked for. */
  private writeDecls(instanceId: string): void {
    // Inherited mounts are derived from the parent's set, never declared; the
    // checkout lives as long as the instance (or Developer Mode) does.
    this.writeDeclFile(instanceId, this.list(instanceId).filter((m) => m.origin !== 'inherited' && KIND_POLICY[m.kind].persist).map((m) => ({
      targetAppId: m.targetAppId, mode: m.mode, data: m.kind === 'data', declaredAt: m.declaredAt,
      ...(m.workspace ? { workspace: m.workspace } : {}),
      ...(m.patches ? { patches: m.patches } : {}),
    })));
  }

  private writeDeclFile(instanceId: string, specs: AddMountSpec[]): void {
    try {
      mkdirSync(dirname(this.declFile(instanceId)), { recursive: true });
      if (specs.length === 0) rmSync(this.declFile(instanceId), { force: true });
      else writeFileSync(this.declFile(instanceId), JSON.stringify(specs, null, 2));
    } catch (err) {
      console.warn(`[MountManager] could not persist mounts for ${instanceId}: ${(err as Error).message}`);
    }
  }

  /**
   * Delete leftover mountpoint DIRECTORIES that no current mount owns.
   *
   * Two ways they arise: a bind that failed after its `mkdir -p`, and — the
   * big one — instance ids are RECYCLED across AppManager generations, so
   * `/data/aura/mounts/com.aura.terminal-2` accumulates dirs from every past
   * life of that name. The result is `ls /mnt/aura` showing entries that
   * `aura mount ls` (truthfully) doesn't list.
   *
   * Safety is structural: `rmdirSync` only removes an EMPTY directory, and a
   * live bind at the path fails it with EBUSY — so real mounts and real data
   * are unremovable by construction, and every failure is simply skipped.
   */
  private pruneStale(instanceId: string): void {
    const current = new Set(this.list(instanceId).map((m) => this.dirName(m.targetAppId, m.kind)));
    const roots = [this.opts.runner.mountRootDir(instanceId)];
    // A sidecar key resolves to its PARENT's data dir — whose legacy root
    // holds the parent's mounts, not the sidecar's. Never prune it from here.
    const dataDir = isSidecarConsumer(instanceId) ? null : this.opts.instanceDataDir(instanceId);
    if (dataDir) roots.push(join(dataDir, MOUNT_DIR_NAME));
    for (const root of roots) {
      let names: string[];
      try { names = readdirSync(root); } catch { continue; }   // root absent
      for (const name of names) {
        if (current.has(name)) continue;
        if (name === WORK_DIR_NAME || name === PATCHES_DIR_NAME) {
          let work: string[] = [];
          try { work = readdirSync(join(root, name)); } catch { /* gone */ }
          for (const app of work) {
            if (current.has(`${name}/${app}`)) continue;
            try { rmdirSync(join(root, name, app)); } catch { /* mounted, non-empty, or gone */ }
          }
        }
        try { rmdirSync(join(root, name)); } catch { /* mounted, non-empty, or gone */ }
      }
    }
  }

  /**
   * Re-create every declared mount for an instance whose container has just
   * started. Called by the AppManager after `onCreate`, so the app sees its
   * mounts as early as propagation allows.
   *
   * Best-effort per mount: one target that has since been uninstalled must not
   * stop the rest from coming back, and none of it may block a spawn.
   */
  async reapply(instanceId: string): Promise<{ restored: number; failed: number }> {
    const specs = this.readDecls(instanceId);
    if (specs.length === 0) { this.pruneStale(instanceId); return { restored: 0, failed: 0 }; }
    if (!this.capable().ok) return { restored: 0, failed: specs.length };

    let restored = 0;
    let failed   = 0;
    // Declarations whose target app is gone are DROPPED, not failed: instance
    // ids recycle across generations, so a dead declaration would otherwise
    // fail on every boot forever ("reapply: restored 0, failed N"). A
    // transient failure for an app that still exists stays declared.
    const kept: AddMountSpec[] = [];
    for (const spec of specs) {
      const id = this.mountId(spec.targetAppId, kindOf(spec));
      if (this.mounts.get(instanceId)?.has(id)) { kept.push(spec); continue; }   // already there (adopted)
      if (!this.opts.registry.getById(spec.targetAppId)) {
        console.log(`[MountManager] dropping declared mount ${id} for ${instanceId} — target app is no longer installed`);
        continue;
      }
      try {
        const m = await this.add(instanceId, spec, { persist: false, origin: 'restored' });
        restored++;
        // A writable source of an app closed since is restored read-only, and stays so.
        kept.push(m.mode === (spec.mode ?? 'ro') || KIND_POLICY[m.kind].modeRule === 'always-rw' ? spec : { ...spec, mode: m.mode });
      } catch (err) {
        failed++;
        kept.push(spec);
        console.warn(`[MountManager] could not restore ${id} into ${instanceId}: ${(err as Error).message}`);
      }
    }
    if (kept.length !== specs.length || kept.some((k, i) => k !== specs[i])) this.writeDeclFile(instanceId, kept);
    this.pruneStale(instanceId);
    if (restored || failed) {
      console.log(`[MountManager] reapply ${instanceId}: restored ${restored}, failed ${failed}`);
    }
    return { restored, failed };
  }

  // ─── Queries ───────────────────────────────────────────────────────────

  /** Whether this host supports propagation at all. */
  capable(): { ok: boolean; reason?: string } {
    return this.opts.runner.canPropagateMounts();
  }

  list(instanceId: string): AuraMount[] {
    return [...(this.mounts.get(instanceId)?.values() ?? [])];
  }

  /** The live binds of a patch workspace (`work` mounts of `subpath`), in every consumer. */
  workspaceBinds(subpath: string): Array<{ instanceId: string; mountId: string }> {
    const out: Array<{ instanceId: string; mountId: string }> = [];
    for (const [consumer, set] of this.mounts) {
      for (const m of set.values()) if (m.kind === 'work' && m.workspace === subpath) out.push({ instanceId: consumer, mountId: m.id });
    }
    return out;
  }

  /**
   * The live truth, read from the kernel rather than our cache. The shell's own
   * `/data` is the volume root, so every instance's `.mnt/<app>` bind is visible
   * in the shell's mountinfo — no docker calls needed to enumerate.
   */
  liveMountPaths(): string[] {
    // Both roots, or reconcile is blind: matching only `/.mnt/` left every
    // canonical-root bind (`<dataDir>/aura/mounts/<id>/…`) unlisted AND
    // unreaped — instance ids recycle, so the leaks accumulated forever.
    const canonicalRoot = `${join(this.opts.dataDir, 'aura', 'mounts')}/`;
    try {
      return readFileSync('/proc/self/mountinfo', 'utf-8')
        .split('\n')
        .map((l) => l.split(' ')[4] ?? '')
        .filter((p) => p.startsWith(`${this.opts.dataDir}/`)
          && (p.includes(`/${MOUNT_DIR_NAME}/`) || (p.startsWith(canonicalRoot) && !p.includes('/.state/'))));
    } catch {
      return [];
    }
  }

  // ─── Path resolution ───────────────────────────────────────────────────

  /** Shell-side path of what we'd mount FROM, for a target app. */
  private resolveSource(targetAppId: string, kind: MountKind, subpath?: string): string {
    if (kind === 'workspace') return WORKSPACE_DIR;
    const manifest = this.opts.registry.getById(targetAppId);
    if (!manifest) throw new Error(`App not found: ${targetAppId}`);
    if (kind === 'work') {
      if (!subpath || !WORKSPACE_SUBPATH.test(subpath)) throw new Error(`invalid workspace: ${JSON.stringify(subpath)}`);
      return join(this.opts.dataDir, subpath);
    }
    if (kind === 'patches') {
      if (!subpath || !PATCHES_SUBPATH.test(subpath)) throw new Error(`invalid patch repository: ${JSON.stringify(subpath)}`);
      return join(this.opts.dataDir, subpath);
    }
    if (kind === 'source') return manifest.appDir;
    // Data: the app-level dir holding every instance's data. Always under
    // dataDir for all three scopes (system's SOURCE is a host bind, but its
    // DATA still lives on the volume).
    const scope = this.opts.scopeRegistry.getById(manifest.scopeId);
    const appLevel = join(scope.dataDir, 'apps', targetAppId);
    if (appLevel !== manifest.appDir) return appLevel;
    // USER-scoped apps live ON the volume: `manifest.appDir` IS the app-level
    // dir, so instance data nests inside the source tree and a "data" mount
    // of the app-level dir was just a second source mount. Mount the primary
    // instance's data dir instead — instance ids are `<appId>` for a
    // singleton (`<appId>-<n>` otherwise), so `apps/<id>/<id>` holds only
    // data.
    return join(appLevel, targetAppId);
  }

  private mountId(targetAppId: string, kind: MountKind): string {
    if (kind === 'workspace') return WORKSPACE_MOUNT_ID;
    return kind === 'source' ? targetAppId : `${targetAppId}:${kind}`;
  }

  /**
   * Which mount root this instance can actually use. Containers spawned before
   * the `/mnt/aura` change don't have it, and mounting into a path the
   * container can't see would succeed on the host and be invisible inside —
   * the worst kind of failure. So we ask the container what it has.
   *
   * Returns the shell-side root dir and the path it appears at inside.
   */
  private rootFor(instanceId: string, consumerDataDir: string): { shellDir: string; containerDir: string } {
    const container = containerName(instanceId);
    try {
      const out = execSync(`docker inspect -f '{{range .Mounts}}{{.Destination}}{{"\\n"}}{{end}}' ${container}`,
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, encoding: 'utf-8' });
      if (out.split('\n').some((d) => d.trim() === MOUNT_ROOT_PATH)) {
        return { shellDir: this.opts.runner.mountRootDir(instanceId), containerDir: MOUNT_ROOT_PATH };
      }
    } catch { /* not inspectable — fall through to the legacy root */ }
    if (isSidecarConsumer(instanceId)) {
      throw new Error(`sidecar ${instanceId} has no mount root at ${MOUNT_ROOT_PATH} — spawn it with mounts.own or inheritMounts`);
    }
    return {
      shellDir: join(consumerDataDir, MOUNT_DIR_NAME),
      containerDir: `/data/${MOUNT_DIR_NAME}`,
    };
  }

  private dirName(targetAppId: string, kind: MountKind): string {
    if (kind === 'workspace') return WORKSPACE_MOUNT_ID;
    if (kind === 'work') return `${WORK_DIR_NAME}/${targetAppId}`;
    if (kind === 'patches') return `${PATCHES_DIR_NAME}/${targetAppId}`;
    return kind === 'data' ? `${targetAppId}.data` : targetAppId;
  }

  /** Whether the target's source is closed (read-only only). */
  private isClosed(targetAppId: string): boolean {
    return this.opts.sourceMode?.(targetAppId) === 'closed';
  }

  // ─── Mutations ─────────────────────────────────────────────────────────

  async add(
    instanceId: string,
    spec: AddMountSpec,
    opts: { persist?: boolean; origin?: MountOrigin } = {},
  ): Promise<AuraMount> {
    const cap = this.capable();
    if (!cap.ok) throw new Error(`mount propagation unavailable: ${cap.reason}`);

    const kind: MountKind = kindOf(spec);
    // A patch repo or workspace (always writable) only for normal apps: built-in apps stay read-only (Q6).
    if (!KIND_POLICY[kind].builtInTargets && this.opts.registry.getById(spec.targetAppId)?.scopeId === 'system') {
      throw new Error(`refusing a ${kind} mount: ${spec.targetAppId} is a built-in app (${SYSTEM_APP_LATER}: ${SYSTEM_APP_LATER_MESSAGE})`);
    }
    let mode: MountMode = KIND_POLICY[kind].modeRule === 'always-rw' ? 'rw' : spec.mode ?? 'ro';
    if (kind === 'source' && mode === 'rw' && this.isClosed(spec.targetAppId)) {
      // A request is refused; a declaration, re-bind or mirror made while the
      // app was open comes back read-only.
      if ((opts.origin ?? 'added') === 'added' && opts.persist !== false) {
        throw new Error(`refusing a writable mount: ${spec.targetAppId} is a closed install — its source is read-only (patch it in a workspace, or the owner opens it with \`aura dev open\`)`);
      }
      console.warn(`[MountManager] ${spec.targetAppId} is closed — mounting its source read-only into ${instanceId}`);
      mode = 'ro';
    }
    const id = this.mountId(spec.targetAppId, kind);
    return this.bind(instanceId, {
      targetAppId: spec.targetAppId, kind, mode, id, declaredAt: spec.declaredAt, workspace: spec.workspace, patches: spec.patches,
    }, opts);
  }

  /**
   * D80: how a writable `source` or `data` mount reaches a consumer that runs
   * as another uid than the files' on-disk owner. Null: no idmap needed (a
   * read-only mount, the same uid, a root consumer with its capabilities, or
   * a kind the consumer owns itself). `ro`: a declaration or re-bind that may
   * no longer be writable (Developer Mode is off, a root-owned data tree)
   * comes back read-only, like a closed source. Otherwise the idmap, or a
   * refusal: never a plain bind that is writable in name only, never broader.
   */
  private crossUid(
    consumer: string, kind: MountKind, srcShell: string, requested: boolean,
  ): { from: { uid: number; gid: number }; to: { uid: number; gid: number } } | 'ro' | null {
    if (kind !== 'source' && kind !== 'data') return null;
    const to = this.opts.consumerIdentity?.(consumer);
    if (!to) return null;
    let st: { uid: number; gid: number };
    try { st = statSync(srcShell); } catch { return null; }   // absent: bind() reports it
    if (st.uid === to.uid) return null;
    const who = `${consumer} runs as ${to.uid}:${to.gid} and the files are owned by ${st.uid}:${st.gid}`;
    const refuse = (why: string): 'ro' => {
      if (requested) throw new Error(`refusing a writable mount: ${who}; ${why}`);
      console.warn(`[MountManager] ${who}; ${why}: mounting it read-only`);
      return 'ro';
    };
    // Owner answer 4: writable source of another uid only in Developer Mode (closed sources were refused above).
    if (kind === 'source' && !this.opts.developerMode?.()) {
      return refuse('a writable source mount into another app\'s uid needs Developer Mode (or patch it in a workspace: aura dev patch start)');
    }
    // An idmap of uid 0 would let the consumer create root-owned files on disk.
    if (kind === 'data' && st.uid === 0) return refuse('a root-owned data tree is never mapped to another uid');
    const probe = this.opts.runner.canIdmapMounts();
    if (!probe.ok || !this.opts.runner.idmapHelperHostPath()) {
      const runtime = this.opts.runtimeOf?.(consumer) ?? 'container';
      throw new RuntimeCapabilityError(runtime, ['idmappedMounts'],
        `refusing a writable mount: ${who}, and runtime ${runtime} has no idmapped mounts (${probe.reason ?? 'unavailable'}); never mounted weaker or broader`);
    }
    return { from: { uid: st.uid, gid: st.gid }, to };
  }

  /**
   * Bind the AuraOS checkout read-write into one consumer (`aura mount
   * workspace`, D60). The caller has checked Developer Mode and that the
   * consumer is the asking System Terminal. Never declared, never mirrored.
   */
  async addWorkspace(instanceId: string): Promise<AuraMount> {
    const cap = this.capable();
    if (!cap.ok) throw new Error(`mount propagation unavailable: ${cap.reason}`);
    if (isSidecarConsumer(instanceId)) throw new Error('the AuraOS checkout is never mounted into a sidecar');
    return this.bind(instanceId, {
      targetAppId: WORKSPACE_MOUNT_ID, kind: 'workspace', mode: 'rw', id: WORKSPACE_MOUNT_ID,
    }, { persist: false });
  }

  /**
   * Revokes writable access (owner answer 4 on D80): every live writable
   * `source`/`data` mount that `match` selects is made read-only again, and
   * so is its declaration. Called when Developer Mode is switched off (the
   * idmapped source mounts) and when a consumer loses `apps.mount`. A mount
   * that can't be re-made read-only stays detached, declared read-only.
   * Never throws; returns the revoked `<consumer>:<mountId>`.
   */
  async revokeWritable(match: (m: AuraMount) => boolean): Promise<string[]> {
    const revoked: string[] = [];
    for (const [consumer, set] of [...this.mounts]) {
      for (const m of [...set.values()]) {
        if (m.mode !== 'rw' || (m.kind !== 'source' && m.kind !== 'data') || m.origin === 'inherited' || !match(m)) continue;
        try { this.unmountHost(consumer, m.hostDest); }
        catch (err) { console.warn(`[MountManager] revoke ${m.id} in ${consumer}: ${(err as Error).message}`); continue; }
        set.delete(m.id);
        revoked.push(`${consumer}:${m.id}`);
        // The inheriting sidecars drop their writable copy first; the read-only re-add mirrors again.
        if (!isSidecarConsumer(consumer) && KIND_POLICY[m.kind].fanout) this.queueFanout(() => this.fanoutRemove(consumer, m.id));
        const ro: AddMountSpec = { targetAppId: m.targetAppId, mode: 'ro', data: m.kind === 'data', declaredAt: m.declaredAt };
        try {
          await this.add(consumer, ro, { origin: m.origin });
        } catch (err) {
          console.warn(`[MountManager] ${m.id} in ${consumer} stays detached: ${(err as Error).message}`);
          this.writeDeclFile(consumer, [...this.readDecls(consumer).filter((d) => !(d.targetAppId === m.targetAppId && !!d.data === (m.kind === 'data'))), ro]);
        }
      }
      if (set.size === 0) this.mounts.delete(consumer);
    }
    await this.settled();
    return revoked;
  }

  /** Every live mount of the AuraOS checkout, in every consumer. */
  workspaceMounts(): AuraMount[] {
    return [...this.mounts.values()].flatMap((set) => [...set.values()].filter((m) => m.kind === 'workspace'));
  }

  private async bind(
    instanceId: string,
    spec: { targetAppId: string; kind: MountKind; mode: MountMode; id: string; declaredAt?: string; workspace?: string; patches?: string },
    opts: { persist?: boolean; origin?: MountOrigin },
  ): Promise<AuraMount> {
    const { kind, id } = spec;

    if (this.mounts.get(instanceId)?.has(id)) {
      throw new Error(`${id} is already mounted into ${instanceId}`);
    }

    const consumerDataDir = this.opts.instanceDataDir(instanceId);
    if (!consumerDataDir) throw new Error(`Instance not found: ${instanceId}`);

    const srcShell = this.resolveSource(spec.targetAppId, kind, kind === 'patches' ? spec.patches : spec.workspace);
    // A data dir only appears once the target has spawned — create it so a
    // data mount of a fresh target binds an empty dir instead of failing.
    if (KIND_POLICY[kind].createsSource) { try { mkdirSync(srcShell, { recursive: true }); } catch { /* mount will report */ } }
    const dirName  = this.dirName(spec.targetAppId, kind);
    const root     = this.rootFor(instanceId, consumerDataDir);
    if (KIND_POLICY[kind].needsMountRoot && root.containerDir !== MOUNT_ROOT_PATH) {
      throw new Error(`${instanceId} has no mount root at ${MOUNT_ROOT_PATH} — restart it to get one`);
    }
    const dstShell = join(root.shellDir, dirName);

    // Refuse to mount an app into itself at the same path — a self-bind of the
    // consumer's own data dir would nest the mount root inside its own source.
    if (srcShell === consumerDataDir || dstShell.startsWith(`${srcShell}/`)) {
      throw new Error(`refusing to mount ${spec.targetAppId} into itself (would nest)`);
    }

    const hostSource = this.opts.runner.toDaemonHostPath(srcShell);
    const hostDest   = this.opts.runner.toDaemonHostPath(dstShell);
    const containerPath = `${root.containerDir}/${dirName}`;

    let mode = spec.mode;
    const plan = mode === 'rw' ? this.crossUid(instanceId, kind, srcShell, (opts.origin ?? 'added') === 'added' && opts.persist !== false) : null;
    if (plan === 'ro') mode = 'ro';
    const idmap = plan && plan !== 'ro'
      ? { from: `${plan.from.uid}:${plan.from.gid}`, to: `${plan.to.uid}:${plan.to.gid}` } : undefined;

    // A bind may already exist at the destination — a survivor from a previous
    // shell generation (binds live in the host kernel, not in this process).
    // Mounting again would STACK a second bind on top; one detach then peels a
    // single layer and the mount "comes back". Adopt the survivor instead, with
    // its ACTUAL mode — verify() below still enforces what was promised.
    const preExisting = this.liveMountPaths().includes(dstShell);
    if (!preExisting && idmap) {
      // D80: the session launcher's `idmap-bind` (Node has no mount_setattr), in the same helper.
      this.runHelper(instanceId, [
        '-v', `${hostSource}:/src`,
        '-v', '/:/host:rshared',
        '-v', `${this.opts.runner.idmapHelperHostPath()!}:${IDMAP_HELPER_PATH}:ro`,
      ], `mkdir -p "/host$1" && { ${IDMAP_HELPER_PATH} idmap-bind /src "/host$1" "$2" "$3" || { rmdir "/host$1" 2>/dev/null || true; exit 1; }; }`,
      hostDest, idmap.from, idmap.to);
    } else if (!preExisting) {
      this.runHelper(instanceId, [
        // The SOURCE carries the ro/rw decision — see the module header.
        '-v', `${hostSource}:/src${mode === 'ro' ? ':ro' : ''}`,
        // `/` is a shared mount, so binds made under /host propagate to the host
        // peer group and thence into every slave (i.e. the app containers).
        '-v', '/:/host:rshared',
        // On bind failure, remove the dir mkdir just made (rmdir: empty only,
        // so a pre-existing dir with content survives) — a failed mount must
        // not leave a phantom entry under the consumer's mount root.
      ], 'mkdir -p "/host$1" && { mount --bind /src "/host$1" || { rmdir "/host$1" 2>/dev/null || true; exit 1; }; }', hostDest);
    }

    const mount: AuraMount = {
      id, instanceId, targetAppId: spec.targetAppId, kind,
      mode: preExisting ? this.readModeAt(dstShell) : mode,
      containerPath, hostSource, hostDest, createdAt: new Date().toISOString(),
      origin: opts.origin ?? 'added',
      declaredAt: spec.declaredAt ?? new Date().toISOString(),
      ...(kind === 'work' ? { workspace: spec.workspace! } : {}),
      ...(kind === 'patches' ? { patches: spec.patches! } : {}),
      ...(idmap && !preExisting ? { idmap } : {}),
    };

    try {
      this.verify(instanceId, mount);
    } catch (err) {
      // Never leave a mount weaker than advertised. Roll back and surface it.
      try { this.unmountHost(instanceId, hostDest); } catch { /* best effort */ }
      throw err;
    }

    if (opts.origin === 'inherited') mount.inheritedFrom = parentOfConsumer(instanceId);
    if (!this.mounts.has(instanceId)) this.mounts.set(instanceId, new Map());
    this.mounts.get(instanceId)!.set(id, mount);
    // `persist: false` while reapply() is replaying what is already on disk.
    if (opts.persist !== false) this.writeDecls(instanceId);
    // A workspace, patch repo or the AuraOS checkout belongs to the consumer that asked for it, not its sidecars.
    if (!isSidecarConsumer(instanceId) && KIND_POLICY[kind].fanout) this.queueFanout(() => this.fanoutAdd(instanceId, mount));
    return mount;
  }

  async remove(instanceId: string, mountId: string): Promise<void> {
    const mount = this.mounts.get(instanceId)?.get(mountId);
    if (!mount) throw new Error(`${mountId} is not mounted into ${instanceId}`);
    if (mount.origin === 'inherited') {
      throw new Error(`${mountId} is inherited from ${mount.inheritedFrom ?? parentOfConsumer(instanceId)} — detach it there, or respawn the sidecar with it in mounts.inherit.exclude`);
    }
    this.unmountHost(instanceId, mount.hostDest);
    this.mounts.get(instanceId)!.delete(mountId);
    this.writeDecls(instanceId);   // an explicit detach is a change of intent
    if (this.mounts.get(instanceId)!.size === 0) this.mounts.delete(instanceId);
    this.pruneStale(instanceId);
    if (!isSidecarConsumer(instanceId) && KIND_POLICY[mount.kind].fanout) this.queueFanout(() => this.fanoutRemove(instanceId, mountId));
  }

  /**
   * Drop every mount for an instance. Called on stop/kill/crash — a leaked bind
   * pins the source filesystem and makes the app-data volume unremovable.
   * Never throws: teardown paths must not be blocked by a stuck unmount.
   */
  removeAll(instanceId: string): void {
    for (const mount of this.list(instanceId)) {
      try { this.unmountHost(instanceId, mount.hostDest); }
      catch (err) { console.warn(`[MountManager] unmount ${mount.id} failed: ${(err as Error).message}`); }
    }
    this.mounts.delete(instanceId);
    // The instance's OS sidecars die with it (reapSiblingsOf), but their binds
    // live in the host kernel and would pin the sources — drop them too.
    // Their declarations stay, exactly like the instance's own on a crash.
    if (!isSidecarConsumer(instanceId)) {
      for (const key of this.sidecarKeysOf(instanceId)) this.removeAll(key);
    }
  }

  /**
   * Forget an instance's mount DECLARATIONS — for a deliberate stop/kill, where
   * the instance is gone for good. Instance ids are recycled, so a leftover
   * declaration file would re-apply a dead instance's mounts to the next
   * instance that happens to get the same id. (A crash keeps them: the respawn
   * is the same instance and should get its mounts back.)
   */
  forget(instanceId: string): void {
    const sidecars = isSidecarConsumer(instanceId) ? [] : this.sidecarKeysOf(instanceId);
    this.removeAll(instanceId);
    this.writeDeclFile(instanceId, []);
    // A deliberate stop ends the sidecars' lives too (they are reaped with
    // the instance): drop their declarations and empty roots as well.
    for (const key of sidecars) this.forgetConsumer(key);
  }

  /**
   * An app's directory was REPLACED (a Nexus install/update renames a fresh
   * copy into place and moves the old one to trash). A bind holds the
   * directory it was made from, so every consumer would silently keep seeing
   * the trashed copy. Re-bind each of the app's mounts at its current path —
   * same mode, origin and declaration. Data mounts too: a user-scoped app's
   * data dir lives inside its source tree and is replaced with it; for one
   * that did not move the re-bind is a no-op.
   *
   * Best-effort per mount; never throws. A mount that cannot be re-made stays
   * declared, so the consumer's next spawn restores it (reapply).
   */
  async rebindTarget(targetAppId: string): Promise<{ rebound: number; failed: number }> {
    let rebound = 0, failed = 0;
    if (!this.capable().ok) return { rebound, failed };
    for (const [consumer, set] of [...this.mounts]) {
      for (const old of [...set.values()]) {
        // A workspace or patch repo does not live in the app's directory.
        if (old.targetAppId !== targetAppId || !KIND_POLICY[old.kind].rebindOnReinstall) continue;
        // A parent's re-add fans out into its sidecars and may already have
        // replaced their inherited copy.
        if (set.get(old.id) !== old) continue;
        try {
          this.unmountHost(consumer, old.hostDest);
          set.delete(old.id);
          const now = await this.add(consumer, {
            targetAppId, mode: old.mode, data: old.kind === 'data', declaredAt: old.declaredAt,
          }, { persist: false, origin: old.origin });
          // Closed since: the declaration says read-only from now on.
          if (now.mode !== old.mode && old.origin !== 'inherited') this.writeDecls(consumer);
          rebound++;
        } catch (err) {
          failed++;
          console.warn(`[MountManager] could not re-bind ${old.id} into ${consumer}: ${(err as Error).message}`);
        }
      }
      if (set.size === 0) this.mounts.delete(consumer);
    }
    await this.settled();
    if (rebound || failed) console.log(`[MountManager] re-bound ${targetAppId}: ${rebound} mount(s), ${failed} failed`);
    return { rebound, failed };
  }

  // ─── Sidecar consumers ─────────────────────────────────────────────────

  /**
   * Sidecar consumer keys of an instance: cached mounts, declaration files,
   * and mount-root dirs — a sidecar whose mounts were all detached has
   * neither of the first two but still owns an (empty) root.
   */
  private sidecarKeysOf(instanceId: string): string[] {
    const prefix = `${instanceId}${SIDECAR_SEP}`;
    const keys = new Set([...this.mounts.keys()].filter((k) => k.startsWith(prefix)));
    try {
      for (const n of readdirSync(dirname(this.declFile('x')))) {
        if (n.startsWith(prefix) && n.endsWith('.json')) keys.add(n.slice(0, -'.json'.length));
      }
    } catch { /* no declarations dir */ }
    try {
      for (const n of readdirSync(dirname(this.opts.runner.mountRootDir(prefix)))) {
        if (n.startsWith(prefix)) keys.add(n);
      }
    } catch { /* no mounts dir */ }
    return [...keys];
  }

  /**
   * Bring a freshly started OS sidecar's mounts up: its own declarations, then
   * (with `inherit`) the parent's current mounts minus `exclude`, capped at
   * read-only with `forceRo`. Called by SidecarManager after `docker start` —
   * a container created later never sees binds that already existed.
   * Best-effort per mount; never throws.
   */
  async reapplyConsumer(
    consumer: string,
    opts: { inherit: boolean; exclude: string[]; forceRo: boolean },
  ): Promise<{ restored: number; inherited: number; failed: number }> {
    let restored = 0, inherited = 0, failed = 0;
    if (!this.capable().ok) return { restored, inherited, failed };
    const have = () => this.mounts.get(consumer) ?? new Map<string, AuraMount>();
    for (const spec of this.readDecls(consumer)) {
      const id = this.mountId(spec.targetAppId, kindOf(spec));
      if (have().has(id)) continue;
      if (!this.opts.registry.getById(spec.targetAppId)) continue;
      try { await this.add(consumer, spec, { persist: false, origin: 'restored' }); restored++; }
      catch (err) { failed++; console.warn(`[MountManager] could not restore ${id} into ${consumer}: ${(err as Error).message}`); }
    }
    if (opts.inherit) {
      for (const m of this.list(parentOfConsumer(consumer))) {
        if (!KIND_POLICY[m.kind].inheritToSidecar || opts.exclude.includes(m.id) || have().has(m.id)) continue;
        try {
          await this.add(consumer, {
            targetAppId: m.targetAppId, data: m.kind === 'data', declaredAt: m.declaredAt,
            mode: opts.forceRo ? 'ro' : m.mode,
          }, { persist: false, origin: 'inherited' });
          inherited++;
        } catch (err) { failed++; console.warn(`[MountManager] could not mirror ${m.id} into ${consumer}: ${(err as Error).message}`); }
      }
    }
    this.pruneStale(consumer);
    if (restored || inherited || failed) {
      console.log(`[MountManager] reapply ${consumer}: restored ${restored}, inherited ${inherited}, failed ${failed}`);
    }
    return { restored, inherited, failed };
  }

  /**
   * A sidecar is gone for good (deleted, or its instance stopped): unmount,
   * drop its declarations, and remove its now-empty mount root. rmdir only —
   * never a recursive delete under a path that may still hold a bind.
   */
  forgetConsumer(consumer: string): void {
    this.removeAll(consumer);
    this.writeDeclFile(consumer, []);
    this.pruneStale(consumer);
    try { rmdirSync(this.opts.runner.mountRootDir(consumer)); } catch { /* busy, non-empty or absent */ }
  }

  /** Resolves once all queued fan-out work has finished. */
  settled(): Promise<void> {
    return this.fanout;
  }

  private queueFanout(job: () => Promise<void>): void {
    if (!this.opts.fanoutTargets) return;
    this.fanout = this.fanout.then(job).catch((err: unknown) => {
      console.warn(`[MountManager] fan-out failed: ${(err as Error).message}`);
    });
  }

  /** Mirror a parent's new mount into each inheriting sidecar. */
  private async fanoutAdd(parent: string, mount: AuraMount): Promise<void> {
    for (const t of this.opts.fanoutTargets?.(parent) ?? []) {
      if (t.exclude.includes(mount.id) || this.mounts.get(t.consumer)?.has(mount.id)) continue;
      try {
        await this.add(t.consumer, {
          targetAppId: mount.targetAppId, data: mount.kind === 'data', declaredAt: mount.declaredAt,
          mode: t.forceRo ? 'ro' : mount.mode,
        }, { persist: false, origin: 'inherited' });
      } catch (err) {
        console.warn(`[MountManager] could not mirror ${mount.id} into ${t.consumer}: ${(err as Error).message}`);
      }
    }
  }

  /** Drop a parent's detached mount from each sidecar that inherited it. */
  private async fanoutRemove(parent: string, mountId: string): Promise<void> {
    for (const t of this.opts.fanoutTargets?.(parent) ?? []) {
      const m = this.mounts.get(t.consumer)?.get(mountId);
      if (!m || m.origin !== 'inherited') continue;
      try {
        this.unmountHost(t.consumer, m.hostDest);
        this.mounts.get(t.consumer)!.delete(mountId);
        if (this.mounts.get(t.consumer)!.size === 0) this.mounts.delete(t.consumer);
        this.pruneStale(t.consumer);
      } catch (err) {
        console.warn(`[MountManager] could not detach ${mountId} from ${t.consumer}: ${(err as Error).message}`);
      }
    }
  }

  // ─── Reconciliation ────────────────────────────────────────────────────

  /**
   * Mounts live in the HOST kernel, so they survive the shell process entirely.
   * After a shell restart our in-memory map is empty while the binds are still
   * there — invisible, unlistable, and un-unmountable through the API. Worse,
   * a bind under a dead instance's data dir pins the source filesystem and
   * makes the app-data volume unremovable.
   *
   * Read the live set from `/proc/self/mountinfo` (the shell's `/data` IS the
   * volume root, so every instance's binds are visible there), then drop any
   * belonging to an instance that no longer exists.
   *
   * @param liveInstanceIds instances the AppManager currently knows about.
   */
  reconcile(liveInstanceIds: Set<string>): { adopted: number; reaped: number } {
    let adopted = 0;
    let reaped  = 0;

    // One mountinfo read per instance, cached across the loop. `null` marks a
    // consumer we could not inspect — those mounts are left untouched rather
    // than guessed at.
    const containerInfo = new Map<string, string | null>();
    const infoFor = (instanceId: string): string | null => {
      if (!containerInfo.has(instanceId)) {
        containerInfo.set(instanceId, this.readMountinfo(instanceId));
      }
      return containerInfo.get(instanceId)!;
    };

    for (const path of this.liveMountPaths()) {
      const parsed = this.parseMountPath(path);
      if (!parsed) continue;
      const { instanceId, dirName } = parsed;

      if (!liveInstanceIds.has(instanceId)) {
        try {
          this.unmountHost(instanceId, this.opts.runner.toDaemonHostPath(path));
          reaped++;
          console.log(`[MountManager] reaped orphan mount ${dirName} (dead instance ${instanceId})`);
        } catch (err) {
          console.warn(`[MountManager] could not reap ${path}: ${(err as Error).message}`);
        }
        continue;
      }

      // Instance ids RECYCLE across AppManager generations, and docker's
      // volume mount is non-recursive — so a bind made for a previous life of
      // this id still exists host-side but is INVISIBLE inside the current
      // container. Adopting it would list (and re-declare!) a mount nobody
      // can see. Visible-inside is the discriminator: propagation delivers
      // every legitimate bind into the running consumer.
      const candidatePath = path.includes(`/${MOUNT_DIR_NAME}/`)
        ? `/data/${MOUNT_DIR_NAME}/${dirName}`
        : `${MOUNT_ROOT_PATH}/${dirName}`;
      const info = infoFor(instanceId);
      if (info === null) continue;   // can't inspect the consumer — leave it
      if (!info.split('\n').some((l) => l.split(' ')[4] === candidatePath)) {
        try {
          this.unmountHost(instanceId, this.opts.runner.toDaemonHostPath(path));
          reaped++;
          console.log(`[MountManager] reaped leaked mount ${dirName} (previous life of ${instanceId})`);
        } catch (err) {
          console.warn(`[MountManager] could not reap ${path}: ${(err as Error).message}`);
        }
        continue;
      }

      // Live instance: re-adopt so the API can see and detach it. Mode is read
      // back from the kernel rather than assumed — we don't know what a
      // previous shell asked for, only what actually exists now.
      const kind: MountKind = dirName === WORKSPACE_MOUNT_ID ? 'workspace' : dirName.startsWith(`${WORK_DIR_NAME}/`) ? 'work'
        : dirName.startsWith(`${PATCHES_DIR_NAME}/`) ? 'patches' : dirName.endsWith('.data') ? 'data' : 'source';
      // `work/<id>` and `patches/<id>` (dirName): the app id follows the prefix dir.
      const targetAppId = kind === 'work' || kind === 'patches' ? dirName.slice(dirName.indexOf('/') + 1)
        : kind === 'data' ? dirName.slice(0, -'.data'.length) : dirName;
      const decl = this.readDecls(instanceId).find((d) => d.targetAppId === targetAppId && kindOf(d) === kind);
      const mount: AuraMount = {
        id: this.mountId(targetAppId, kind),
        instanceId, targetAppId,
        kind,
        mode: this.readModeAt(path),
        containerPath: path.includes(`/${MOUNT_DIR_NAME}/`)
          ? `/data/${MOUNT_DIR_NAME}/${dirName}`
          : `${MOUNT_ROOT_PATH}/${dirName}`,
        hostSource: '(adopted — source unknown)',
        hostDest: this.opts.runner.toDaemonHostPath(path),
        createdAt: new Date().toISOString(),
        origin: 'adopted',
        declaredAt: decl?.declaredAt ?? new Date().toISOString(),
        ...(kind === 'work' && decl?.workspace ? { workspace: decl.workspace } : {}),
        ...(kind === 'patches' && decl?.patches ? { patches: decl.patches } : {}),
      };
      if (!this.mounts.has(instanceId)) this.mounts.set(instanceId, new Map());
      this.mounts.get(instanceId)!.set(mount.id, mount);
      adopted++;
    }

    // On a sidecar, a mount it never declared itself can only have come from
    // its app — mark it inherited so it stays derived (and unpersisted).
    for (const [key, set] of this.mounts) {
      if (!isSidecarConsumer(key)) continue;
      const own = new Set(this.readDecls(key).map((d) => this.mountId(d.targetAppId, kindOf(d))));
      for (const m of set.values()) {
        if (m.origin === 'adopted' && !own.has(m.id)) { m.origin = 'inherited'; m.inheritedFrom = parentOfConsumer(key); }
      }
    }

    // An adopted mount was declared by someone, even if the shell that recorded
    // it is gone — persist it so the next restart can re-apply rather than
    // adopt-or-lose. Pre-existing mounts thus become durable on first contact.
    for (const instanceId of this.mounts.keys()) this.writeDecls(instanceId);

    const swept = this.sweepDeclarations(liveInstanceIds);

    if (adopted || reaped || swept) {
      console.log(`[MountManager] reconcile: adopted ${adopted}, reaped ${reaped}, swept ${swept} stale declaration(s)`);
    }
    return { adopted, reaped };
  }

  /**
   * Delete declaration files of NUMBERED instances (`<appId>-<n>`) that aren't
   * live. Those ids are recycled, so a leftover file would hand a dead
   * instance's mounts to whichever new instance next gets the id — `forget()`
   * covers a clean stop, this covers a shell that died mid-stop.
   *
   * Bare-appId instances (single-instance apps) are left alone: their id is
   * never handed to a different instance, and they may simply not be spawned
   * yet at startup — sweeping them would drop mounts the user still wants.
   */
  private sweepDeclarations(liveInstanceIds: Set<string>): number {
    const dir = dirname(this.declFile('x'));
    let names: string[];
    try { names = readdirSync(dir); } catch { return 0; }
    let swept = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const instanceId = name.slice(0, -'.json'.length);
      // A sidecar's declarations never outlive its instance.
      if (isSidecarConsumer(instanceId)) {
        if (liveInstanceIds.has(parentOfConsumer(instanceId))) continue;
        try { rmSync(join(dir, name), { force: true }); swept++; } catch { /* next boot */ }
        continue;
      }
      if (!/-\d+$/.test(instanceId) || liveInstanceIds.has(instanceId)) continue;
      try { rmSync(join(dir, name), { force: true }); swept++; } catch { /* next boot */ }
    }
    return swept;
  }

  /**
   * Pull the instanceId + mounted dir name out of a shell-side mount path.
   * Handles both roots:
   *   <dataDir>/aura/mounts/<instanceId>/<dirName>            (canonical)
   *   <dataDir>/scopes/.../apps/<appId>/<instanceId>/.mnt/<dirName>  (legacy)
   */
  private parseMountPath(path: string): { instanceId: string; dirName: string } | null {
    const volume = new RegExp(`/aura/mounts/([^/]+)/(${WORK_DIR_NAME}|${PATCHES_DIR_NAME})/([^/]+)$`).exec(path);
    if (volume) return { instanceId: volume[1]!, dirName: `${volume[2]!}/${volume[3]!}` };
    const canonical = path.match(/\/aura\/mounts\/([^/]+)\/([^/]+)$/);
    if (canonical) return { instanceId: canonical[1]!, dirName: canonical[2]! };
    const legacy = new RegExp(`/([^/]+)/${MOUNT_DIR_NAME}/([^/]+)$`).exec(path);
    if (legacy) return { instanceId: legacy[1]!, dirName: legacy[2]! };
    return null;
  }

  /** Read a mount's actual ro/rw state from the shell's own mountinfo. */
  private readModeAt(path: string): MountMode {
    try {
      const line = readFileSync('/proc/self/mountinfo', 'utf-8')
        .split('\n').find((l) => l.split(' ')[4] === path);
      return (line?.split(' ')[5] ?? '').split(',').includes('ro') ? 'ro' : 'rw';
    } catch { return 'rw'; }
  }

  // ─── Helper container ──────────────────────────────────────────────────

  /**
   * Run a privileged throwaway container to do the (un)mount. The shell has no
   * CAP_SYS_ADMIN and its own mounts are slave-only, so it cannot mount itself.
   * Mirrors the helper pattern in @aura/app-sdk's sidecars.
   *
   * Path arguments are passed as positional argv, never interpolated into the
   * shell string — they come from `docker volume inspect`, not a literal.
   */
  private runHelper(instanceId: string, mounts: string[], script: string, ...args: string[]): void {
    execFileSync('docker', [
      'run', '--rm', '--privileged',
      '--label', 'aura.mount=1',
      '--label', `aura.parent=${parentOfConsumer(instanceId)}`,
      ...mounts,
      HELPER_IMAGE,
      '/bin/sh', '-euc', script, '_', ...args,
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  }

  private unmountHost(instanceId: string, hostDest: string): void {
    // Loop: binds can be STACKED (one per shell generation, before add()
    // learned to adopt survivors) and one umount peels one layer. Lazy
    // fallback so a shell sitting inside the mount can't block detach;
    // a lazy detach still propagates.
    this.runHelper(instanceId, ['-v', '/:/host:rshared'],
      'while umount "/host$1" 2>/dev/null; do :; done; umount -l "/host$1" 2>/dev/null || true; rmdir "/host$1" 2>/dev/null || true',
      hostDest);
  }

  // ─── Verification ──────────────────────────────────────────────────────

  /**
   * The consumer container's own mount table, or null when it can't be read.
   * App containers run aura-base (has `cat`). A sidecar may run an image
   * without one (distroless, scratch), so for sidecars fall back to a helper
   * that joins its PID namespace and reads PID 1's view — unprivileged.
   */
  private readMountinfo(consumer: string): string | null {
    const container = containerName(consumer);
    try {
      return execFileSync('docker', ['exec', container, 'cat', '/proc/self/mountinfo'],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, encoding: 'utf-8' });
    } catch { /* no container, or no `cat` in it */ }
    if (!isSidecarConsumer(consumer)) return null;
    try {
      return execFileSync('docker', ['run', '--rm', '--label', 'aura.mount=1', '--label', `aura.parent=${parentOfConsumer(consumer)}`,
        `--pid=container:${container}`, HELPER_IMAGE, 'cat', '/proc/1/mountinfo'],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, encoding: 'utf-8' });
    } catch { return null; }
  }

  /**
   * Confirm the mount actually landed in the target container with the mode we
   * promised. Reading the container's own mountinfo needs no privileges.
   * Guards against the two silent failures: propagation not arriving at all,
   * and a "read-only" mount that is really read-write.
   */
  private verify(instanceId: string, mount: AuraMount): void {
    const info = this.readMountinfo(instanceId);
    if (info === null) {
      // A sidecar runs a foreign image: an unverifiable read-only promise is
      // exactly the silent downgrade this check exists to prevent.
      if (isSidecarConsumer(instanceId) && mount.mode === 'ro') {
        throw new Error(`could not verify read-only ${mount.id} in sidecar ${instanceId} — refusing an unverified ro mount`);
      }
      // Consumer isn't a running container (proot, or already gone). We can't
      // verify, so don't claim we did.
      console.warn(`[MountManager] could not verify ${mount.id} in ${instanceId} (not a running container)`);
      return;
    }
    const line = info.split('\n').find((l) => l.split(' ')[4] === mount.containerPath);
    if (!line) {
      throw new Error(`mount did not propagate into ${instanceId} at ${mount.containerPath}`);
    }
    const opts = line.split(' ')[5] ?? '';
    const isRo = opts.split(',').includes('ro');
    if (mount.mode === 'ro' && !isRo) {
      throw new Error(
        `refusing mount: requested read-only but ${mount.containerPath} is read-write in ${instanceId}`,
      );
    }
    // D80: a cross-uid writable mount that arrived without its idmapping would be writable in name only.
    if (mount.idmap && !opts.split(',').includes('idmapped')) {
      throw new Error(`refusing mount: ${mount.containerPath} arrived in ${instanceId} without its idmapping`);
    }
  }
}

/** What a declaration or request mounts. */
function kindOf(spec: AddMountSpec): MountKind {
  return spec.patches ? 'patches' : spec.workspace ? 'work' : spec.data ? 'data' : 'source';
}
