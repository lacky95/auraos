/**
 * The maintenance start and the instance update: FROZEN contract (Phase 6 Stage 1b, 6B.0; D108 A3).
 * A leaf: type-only imports. Phase 6 stream M implements it (AppManager update region,
 * `updateInstance()`, the lifecycle client); Phase 7c P3 (the setup engine) builds against it.
 * Changing a shape here is a contract change: coordinate with both.
 *
 * A maintenance start runs an app's NEW code with no traffic routed to it (no proxy, no App Host,
 * no intents, no activity claim), calls the maintenance hooks, then either serves (the normal start
 * continues: `onStart`, ready, routing) or stops. It is the one path for "start without traffic":
 * reason `update` (stream M: `onUpdate` after a Nexus update or a release switch) and `setup` (7c:
 * `onSetup` / `onValidate` / `onMigrateConfig`). `repair` and `migrate` are reserved names, not built.
 * Apps without a declared maintenance need are started as today (D108 binding): nothing here
 * changes a direct start.
 */
import type { AuraErrorBody } from '../errors/contracts.js';

/** Why a maintenance start runs. */
export type MaintenanceReason = 'update' | 'setup';
/** Reserved for later phases; refused until built. */
export type ReservedMaintenanceReason = 'repair' | 'migrate';
export const MAINTENANCE_REASONS: readonly MaintenanceReason[] = ['update', 'setup'];

/**
 * The stop reason the kernel sends as `x-aura-stop-reason` (SDK `LifecycleContext.reason`):
 * `update` is new with stream M (the drain before an update); older SDKs read it as null.
 */
export type StopReason = 'user' | 'restart' | 'update';

/** Hooks a maintenance start may call (optional hooks: absent → skipped, never an error). */
export type MaintenanceHook = 'onUpdate' | 'onSetup' | 'onValidate' | 'onMigrateConfig';

export interface MaintenanceStartOptions {
  reason: MaintenanceReason;
  /** The verified user the start is for (D46); absent: the local owner. */
  userId?: string;
  /** `update`: the versions from the manifests (`version`); the hook is not called when equal. */
  fromVersion?: string;
  toVersion?: string;
  /** Per-hook timeout; default 120 s (stream M). */
  hookTimeoutMs?: number;
}

/** A running maintenance start: the instance exists, receives no traffic, and can be called. */
export interface MaintenanceSession {
  readonly instanceId: string;
  readonly appId: string;
  readonly reason: MaintenanceReason;
  readonly startedAt: number;
  /** Call one maintenance hook with a JSON body; resolves to its JSON answer (null when the app has no such hook). */
  callHook(hook: MaintenanceHook, body?: unknown): Promise<unknown>;
  /** `serve`: continue as a normal start (onStart, ready, routing). `stop`: stop it (reason `update`/`user`), nothing routed. */
  finish(outcome: 'serve' | 'stop'): Promise<void>;
}

/** The refusal of a maintenance start (D105 body; e.g. the D108 start gate, a runtime refusal). */
export interface MaintenanceRefusal {
  ok: false;
  error: AuraErrorBody;
}

export type MaintenanceStartResult = { ok: true; session: MaintenanceSession } | MaintenanceRefusal;

/** The kernel port: implemented by AppManager (stream M), used by `updateInstance()` and the 7c setup engine. */
export interface MaintenanceStarter {
  startMaintenance(appId: string, opts: MaintenanceStartOptions): Promise<MaintenanceStartResult>;
}

/** `updateInstance()` (stream M): drain → switch the code → maintenance start `update` → `onUpdate` → serve. */
export interface UpdateInstanceOptions {
  fromVersion: string;
  toVersion: string;
  /** Switches the code (a Nexus install or a release switch) between the drain and the maintenance start. */
  switchCode(): Promise<void>;
  userId?: string;
}

export type UpdateInstanceOutcome =
  /** The new code serves. */
  | { ok: true; instanceId: string | null; hookCalled: boolean }
  /** The update failed; `rolledBack` says whether the old code is back (Nexus rollback tree / release rollback). */
  | { ok: false; error: AuraErrorBody; rolledBack: boolean };

export interface InstanceUpdater {
  updateInstance(appId: string, opts: UpdateInstanceOptions): Promise<UpdateInstanceOutcome>;
}
