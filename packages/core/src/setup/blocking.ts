/**
 * `blocked` (D108 decision 10, D107): an app whose counted authorization,
 * D64 policy or ARI feature is gone is stopped and blocked, never
 * reconfigured. Its desired configuration stays as it was (a revoked
 * `home.private` never turns into the App Home); the gate refuses every
 * start. Re-authorization (the grant back, the policy back, the feature
 * back) returns it to `ready` with the same digests, without asking for any
 * value again.
 *
 *   blockingDecision  pure: from the summary and the current resolution
 *   BlockingWatcher   when to re-check: every `permissions:changed` (a
 *                     grant given or revoked, debounced) and a periodic
 *                     pass (D64 policy and runtime settings have no kernel
 *                     event yet), over the apps that declare setup/profiles
 *
 * The engine (service.ts) applies a decision: the transition, stopping the
 * workloads (instances and their sidecars), P9's Private Home teardown,
 * the audit row and `app:setup-state`.
 */
import { OsEventBus } from '../ipc/OsEventBus.js';
import { setupError, type InstallationSetupSummary, type Resolution, type SetupErrorBody } from './contracts.js';

/** What counts as a lost authorization, policy or feature (never a plain configuration error: that is a repair). */
const BLOCKING_CODES = new Set(['requirement-unauthorized', 'policy-refused', 'requirement-unsupported']);

export type BlockingDecision =
  | { kind: 'none' }
  | { kind: 'block'; error: SetupErrorBody; privateHomeLost: boolean }
  | { kind: 'unblock' };

export function blockingDecision(summary: InstallationSetupSummary, r: Resolution): BlockingDecision {
  if (summary.state === 'ready') {
    if (r.effective) return { kind: 'none' };
    const lost = r.blocking.filter((b) => BLOCKING_CODES.has(b.error));
    if (!lost.length) return { kind: 'none' };
    const missing = [...new Set(lost.flatMap((b) => (b.missing ?? []).filter((m): m is string => typeof m === 'string')))].sort();
    const policy = lost.find((b) => b.policy)?.policy;
    const error = setupError('setup-blocked', lost.length === 1 ? lost[0]!.message : `${lost.length} requirements of its setup are no longer met: ${lost.map((b) => b.message).join('; ')}`, {
      state: 'blocked', ...(missing.length ? { missing } : {}), ...(policy ? { policy } : {}),
      hint: 'approve the missing grant again, restore the policy or the runtime feature, or reconfigure the app; nothing is changed for you',
    });
    const privateHomeLost = r.requested.homeEnvironment === 'private'
      && lost.some((b) => (b.missing ?? []).some((m) => typeof m === 'string' && m.startsWith('home.private')) || b.policy === 'app-private-home');
    return { kind: 'block', error, privateHomeLost };
  }
  if (summary.state === 'blocked' && r.effective && r.configDigest === summary.configDigest && r.grantDigest === summary.grantDigest) {
    return { kind: 'unblock' };
  }
  return { kind: 'none' };
}

export interface BlockingWatcherDeps {
  recheck(appId: string): Promise<void>;
  /** The installed apps that declare setup or profiles. */
  appIds(): string[];
  /** Periodic pass (ms); default 60 s. 0 disables it (tests). */
  intervalMs?: number;
  debounceMs?: number;
}

export class BlockingWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private readonly onPermissions = () => this.soon();

  constructor(private readonly deps: BlockingWatcherDeps) {}

  start(): void {
    OsEventBus.on('permissions:changed', this.onPermissions);
    const every = this.deps.intervalMs ?? 60_000;
    if (every > 0) {
      this.timer = setInterval(() => { void this.pass(); }, every);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  stop(): void {
    OsEventBus.off('permissions:changed', this.onPermissions);
    if (this.timer) clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.timer = null;
    this.pending = null;
  }

  private soon(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => { this.pending = null; void this.pass(); }, this.deps.debounceMs ?? 200);
    (this.pending as { unref?: () => void }).unref?.();
  }

  /** One re-check of every declaring app. */
  async pass(): Promise<void> {
    for (const appId of this.deps.appIds()) {
      await this.deps.recheck(appId).catch((err) => console.warn(`[setup] re-check of ${appId} failed: ${(err as Error).message}`));
    }
  }
}
