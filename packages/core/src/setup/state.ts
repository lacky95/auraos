/**
 * The operational state machine of D108 (§3.1, §3.3) over the setup summary
 * on the installation record (`AppInstallation.setup`, written only through
 * `AppHostStore.setSetup`, compare-and-set).
 *
 * - An app without `setup` and `profiles` is `ready` by derivation: nothing
 *   is read or written for it, ever.
 * - Every write names the summary it replaces (`expect`); a changed summary
 *   is a `conflict`, never overwritten.
 * - Transitions follow `OPERATIONAL_TRANSITIONS`; anything else is refused
 *   with `illegal-transition`. `ready` is entered only through `markReady`,
 *   with the `configDigest`/`grantDigest` the engine validated; until then
 *   the summary keeps the previous `ready` digest (a rolled-back
 *   reconfiguration leaves it unchanged).
 * - Resumption data (`step`, `attempt`, `approvalId`) is written by
 *   `progress` before a step acts.
 * - A tampered desired record (store.ts) reads as absent and resets the
 *   state to `setup-required` once (`resetTampered`, from any state: it is an
 *   integrity reset, not a step of a run). The audit is the store's
 *   `onTampered`, once per stored record.
 *
 * The engine (P3) emits `app:setup-state` and audits state changes; this
 * module only decides and stores.
 */
import type { AppInstallation } from '../app-hosts/contracts.js';
import type { AppHostStore } from '../app-hosts/AppHostRegistry.js';
import {
  declaresSetup, OPERATIONAL_TRANSITIONS, setupError,
  type InstallationSetupSummary, type OperationalState, type SetupErrorBody, type SetupStep,
} from './contracts.js';
import type { ConfigRecordRef, SetupConfigStore } from './store.js';

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_RESET_ATTEMPTS = 8;

export type SetupStateErrorCode = 'illegal-transition' | 'conflict' | 'not-declared' | 'unknown-installation' | 'digest-required';

export class SetupStateError extends Error {
  constructor(readonly code: SetupStateErrorCode, message: string) {
    super(message);
    this.name = 'SetupStateError';
  }
}

/** Is `from → to` a legal transition? `from` null: no summary yet (only `setup-required` begins one). */
export function canTransition(from: OperationalState | null, to: OperationalState): boolean {
  if (from === null) return to === 'setup-required';
  return OPERATIONAL_TRANSITIONS[from].includes(to);
}

/** Where an installation stands: derived `ready` (no summary, nothing stored) for an app without setup/profiles. */
export interface DerivedSetupState {
  declares: boolean;
  state: OperationalState;
  /** The stored summary; null when none is stored (simple app, or a configured app not yet begun). */
  summary: InstallationSetupSummary | null;
}

/** The manifest part the state machine reads. */
export type DeclaringManifest = { setup?: unknown; profiles?: unknown };

export function deriveSetupState(installation: Pick<AppInstallation, 'setup'> | null, manifest: DeclaringManifest): DerivedSetupState {
  if (!declaresSetup(manifest)) return { declares: false, state: 'ready', summary: null };
  const summary = installation?.setup ?? null;
  return { declares: true, state: summary?.state ?? 'setup-required', summary };
}

/** Same-state data of a step (§3.3). */
export interface SetupProgress {
  step?: SetupStep | null;
  attempt?: number;
  /** null clears it. */
  approvalId?: string | null;
  profile?: string | null;
}

/** What a transition may set besides the state. */
export interface SetupTransitionPatch extends SetupProgress {
  /** The refusal or failure the new state reports (D105, no value). Cleared when absent. */
  error?: SetupErrorBody;
}

export interface SetupStateMachineOptions {
  registry: Pick<AppHostStore, 'getInstallation' | 'setSetup'>;
  store: Pick<SetupConfigStore, 'read'>;
  now?: () => Date;
}

export class SetupStateMachine {
  private readonly now: () => Date;

  constructor(private readonly opts: SetupStateMachineOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  private async installation(installationId: string): Promise<AppInstallation> {
    const i = await this.opts.registry.getInstallation(installationId);
    if (!i) throw new SetupStateError('unknown-installation', `unknown installation ${installationId}`);
    return i;
  }

  private async write(installationId: string, expect: InstallationSetupSummary | null, next: InstallationSetupSummary): Promise<InstallationSetupSummary> {
    const r = await this.opts.registry.setSetup(installationId, expect, next);
    if (!r.ok) {
      if (!r.installation) throw new SetupStateError('unknown-installation', `unknown installation ${installationId}`);
      throw new SetupStateError('conflict', `the setup state of ${r.installation.appId} changed meanwhile`);
    }
    return next;
  }

  /** The installation's state (derived `ready`, with no read of any record, for a simple app's manifest). */
  async state(installationId: string, manifest: DeclaringManifest): Promise<DerivedSetupState> {
    if (!declaresSetup(manifest)) return { declares: false, state: 'ready', summary: null };
    return deriveSetupState(await this.installation(installationId), manifest);
  }

  /**
   * The first summary of an app that declares setup or profiles:
   * `setup-required`. Idempotent: an existing summary is returned unchanged.
   * Refuses (`not-declared`) for a simple app: it never gets a summary.
   */
  async begin(installationId: string, manifest: DeclaringManifest): Promise<InstallationSetupSummary> {
    if (!declaresSetup(manifest)) throw new SetupStateError('not-declared', 'the app declares neither setup nor profiles');
    const cur = await this.installation(installationId);
    if (cur.setup) return cur.setup;
    return this.write(installationId, null, {
      state: 'setup-required', profile: null, configDigest: null, grantDigest: null, step: null, attempt: 0,
      updatedAt: this.now().toISOString(),
    });
  }

  /**
   * One legal transition, compare-and-set on `expect`. Never into `ready`
   * (`markReady`). The digests stay those of the last `ready`; `approvalId`
   * survives only in `awaiting-approval` and `initializing`; `error` only when given.
   */
  async transition(installationId: string, expect: InstallationSetupSummary, to: OperationalState, patch: SetupTransitionPatch = {}): Promise<InstallationSetupSummary> {
    if (to === 'ready') throw new SetupStateError('digest-required', '`ready` is entered only with the validated digest (markReady)');
    if (!canTransition(expect.state, to)) throw new SetupStateError('illegal-transition', `${expect.state} → ${to} is not a legal setup transition`);
    const approvalId = patch.approvalId === undefined ? expect.approvalId : patch.approvalId ?? undefined;
    const next: InstallationSetupSummary = {
      state: to,
      profile: patch.profile !== undefined ? patch.profile : expect.profile,
      configDigest: expect.configDigest, grantDigest: expect.grantDigest,
      step: patch.step !== undefined ? patch.step : expect.step,
      attempt: patch.attempt ?? expect.attempt,
      // The approval of the run: while it is asked, and (P3) while the approved run initializes, so a
      // kernel restart there still knows what it covers.
      ...((to === 'awaiting-approval' || to === 'initializing') && approvalId ? { approvalId } : {}),
      updatedAt: this.now().toISOString(),
      ...(patch.error ? { error: patch.error } : {}),
    };
    return this.write(installationId, expect, next);
  }

  /**
   * Same-state resumption data, written before a step acts (§3.3). Not in
   * `ready` (its summary changes only by a transition).
   */
  async progress(installationId: string, expect: InstallationSetupSummary, p: SetupProgress): Promise<InstallationSetupSummary> {
    if (expect.state === 'ready') throw new SetupStateError('illegal-transition', 'a `ready` installation records no setup progress; reconfigure first');
    const approvalId = p.approvalId === undefined ? expect.approvalId : p.approvalId ?? undefined;
    const { approvalId: _a, error: _e, ...rest } = expect;
    const next: InstallationSetupSummary = {
      ...rest,
      ...(p.step !== undefined ? { step: p.step } : {}),
      ...(p.attempt !== undefined ? { attempt: p.attempt } : {}),
      ...(p.profile !== undefined ? { profile: p.profile } : {}),
      ...(approvalId ? { approvalId } : {}),
      ...(expect.error ? { error: expect.error } : {}),
      updatedAt: this.now().toISOString(),
    };
    return this.write(installationId, expect, next);
  }

  /**
   * The engine's one way into `ready` (§3.1): after init and readiness
   * succeeded, compare-and-set with the digests it validated. A missing or
   * malformed digest is refused; a changed summary is a conflict.
   */
  async markReady(installationId: string, expect: InstallationSetupSummary, d: { configDigest: string; grantDigest: string; profile: string | null }): Promise<InstallationSetupSummary> {
    if (!DIGEST_RE.test(d.configDigest ?? '') || !DIGEST_RE.test(d.grantDigest ?? '')) {
      throw new SetupStateError('digest-required', '`ready` needs the validated configDigest and grantDigest (sha256:<hex>)');
    }
    if (!canTransition(expect.state, 'ready')) throw new SetupStateError('illegal-transition', `${expect.state} → ready is not a legal setup transition`);
    return this.write(installationId, expect, {
      state: 'ready', profile: d.profile, configDigest: d.configDigest, grantDigest: d.grantDigest,
      step: 'done', attempt: 0, updatedAt: this.now().toISOString(),
    });
  }

  /**
   * A desired record for the engine: a tampered one is absent, and the
   * installation is reset to `setup-required` (once).
   */
  async desired(ref: ConfigRecordRef) {
    const r = await this.opts.store.read(ref);
    if (r.tampered) await this.resetTampered(ref.installationId);
    return r;
  }

  /**
   * A tampered (or unverifiable) desired record: the installation needs
   * setup again. From any state; a no-op when it is already
   * `setup-required` (so it happens once) or not active. The digests and the
   * profile are dropped: nothing validated against the lost record counts.
   */
  async resetTampered(installationId: string): Promise<{ changed: boolean }> {
    for (let i = 0; i < MAX_RESET_ATTEMPTS; i++) {
      const cur = await this.installation(installationId);
      if (cur.state !== 'active' || cur.setup?.state === 'setup-required') return { changed: false };
      const next: InstallationSetupSummary = {
        state: 'setup-required', profile: null, configDigest: null, grantDigest: null, step: null, attempt: 0,
        updatedAt: this.now().toISOString(),
        error: setupError('setup-required', 'the stored setup configuration failed its integrity check; set the app up again', { state: 'setup-required' }),
      };
      const r = await this.opts.registry.setSetup(installationId, cur.setup ?? null, next);
      if (r.ok) return { changed: true };
    }
    throw new SetupStateError('conflict', `the setup state of ${installationId} kept changing during an integrity reset`);
  }
}
