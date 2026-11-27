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
 * The runtime realises an exposure through its `endpoints` group (5b-2 D-P;
 * the container module: forwarder containers, runtimes/container/endpoints.ts)
 * and is the record of what runs: `list()` rehydrates the live set after a
 * shell restart. This manager keeps the policy: ids, the running-source and
 * running-target checks, declarations, replay, and reaping exposures whose
 * owner is gone for good (`reconcile()`).
 *
 * ## Lifecycle & state
 *
 * Exposes are ephemeral by default. A `sticky` expose ALSO writes a declaration
 * to `<dataDir>/aura/ports/.state/<ownerInstanceId>.json`, which `reapply()`
 * replays after the owner's container comes back up (mirrors MountManager).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppRegistry } from './AppRegistry.js';
import type { ContainerPortBackend } from '../runtimes/container/backends.js';
import type { RuntimeEndpoints, RuntimeExposure } from '../runtimes/ari.js';

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

/** An exposure that IS running, as its runtime keeps it (`RuntimeExposure`). */
export type AuraPortExpose = RuntimeExposure;

interface PortManagerOpts {
  dataDir: string;
  runner: ContainerPortBackend;
  /** The runtime's `endpoints` group (the container module's). */
  endpoints: RuntimeEndpoints;
  registry: AppRegistry;
  /** Resolve an appId to its running instance (any running one). Null if none. */
  resolveRunningInstance(appId: string): { instanceId: string } | null;
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

  // ─── Queries ─────────────────────────────────────────────────────────────

  /** The live set, as the runtime keeps it (authoritative across shell restarts). */
  private snapshot(): AuraPortExpose[] {
    return this.opts.endpoints.list();
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
    const id = this.specId(spec);

    // Already exposed? Deterministic ids make this a cheap check and give a
    // clean 409 upstream instead of a runtime name-conflict stack trace.
    if (this.list(ownerInstanceId).some((e) => e.id === id)) {
      throw new Error(`${id} is already exposed on ${ownerInstanceId}`);
    }
    if (spec.kind === 'into' && !this.opts.runner.isRunning(ownerInstanceId)) {
      throw new Error(`target instance ${ownerInstanceId} is not running`);
    }

    const record = await this.opts.endpoints.expose({
      id, kind: spec.kind, ownerInstanceId,
      sourceAppId: spec.sourceAppId, sourceInstanceId: source.instanceId,
      sourcePort: spec.sourcePort, port: spec.port ?? spec.sourcePort,
      ...(spec.kind === 'host' ? { bindAddr: spec.bindAddr ?? '127.0.0.1' } : {}),
      sticky: spec.sticky === true,
    });
    if (record.sticky) this.addDecl(ownerInstanceId, spec);
    return record;
  }

  remove(ownerInstanceId: string, portId: string): void {
    const existing = this.list(ownerInstanceId).find((e) => e.id === portId);
    if (!existing) throw new Error(`${portId} is not exposed on ${ownerInstanceId}`);
    this.opts.endpoints.remove(existing.containerName);
    this.dropDecl(ownerInstanceId, portId);
  }

  /**
   * Tear down every forwarder owned by an instance. Called on stop/kill/crash.
   * Keeps the sticky declarations so a later restart re-establishes them.
   * Never throws — teardown paths must not be blocked.
   */
  removeAll(instanceId: string): void {
    for (const e of this.list(instanceId)) {
      try { this.opts.endpoints.remove(e.containerName); }
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
        this.opts.endpoints.remove(e.containerName);
        reaped++;
        console.log(`[PortManager] reaped orphan forwarder ${e.id} (dead owner ${e.ownerInstanceId})`);
      } catch (err) {
        console.warn(`[PortManager] could not reap ${e.containerName}: ${(err as Error).message}`);
      }
    }
    if (reaped) console.log(`[PortManager] reconcile: reaped ${reaped}`);
    return { reaped };
  }
}
