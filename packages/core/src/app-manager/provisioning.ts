/** Compatibility markers for custom entrypoints. Managed dependencies are prepared before spawn. */
/** Printed by the synthesised entrypoint around the provisioning block. */
export const PROVISION_BEGIN = '@@aura:provision:begin@@';
export const PROVISION_END   = '@@aura:provision:end@@';

/**
 * Absolute ceiling on provisioning, so a wedged install still fails rather
 * than hanging a start forever. Generous on purpose: this bounds a cold
 * dependency install on a slow link, not a health check.
 */
export const PROVISION_TIMEOUT_MS = 15 * 60_000;

/**
 * Tracks whether an app's entrypoint is currently provisioning, by watching
 * its log for the markers above.
 *
 * Deliberately a state machine over the log rather than a probe into the
 * container: the runners already fan the app's stdout into the shell's, so
 * this costs one substring check per chunk and needs no extra `docker exec`
 * on every 200ms health poll.
 */
export class ProvisionWatch {
  private active = false;
  private seen   = false;

  /** Feed a chunk of app output. Safe to call with partial lines. */
  observe(chunk: string): void {
    // Order matters: a single chunk can contain both markers when a warm app
    // provisions nothing, and "ended" is the correct resting state for that.
    if (chunk.includes(PROVISION_BEGIN)) { this.active = true; this.seen = true; }
    if (chunk.includes(PROVISION_END))   { this.active = false; }
  }

  /** True while the entrypoint is installing dependencies. */
  get isProvisioning(): boolean { return this.active; }
  /** True once provisioning has been seen at all — for error messages. */
  get everProvisioned(): boolean { return this.seen; }
}

/**
 * The health-wait deadline for the next poll.
 *
 * Extracted from both runners so the rule is stated once and can be tested
 * without spawning a container: while the entrypoint is provisioning, the app
 * has not been asked to start yet, so the boot budget is pushed back and only
 * begins counting when provisioning ends. `hardDeadline` bounds the whole
 * wait so a wedged install still fails.
 */
export function nextHealthDeadline(opts: {
  now:            number;
  deadline:       number;
  hardDeadline:   number;
  isProvisioning: boolean;
  bootBudgetMs:   number;
}): number {
  const { now, deadline, hardDeadline, isProvisioning, bootBudgetMs } = opts;
  if (!isProvisioning || now >= hardDeadline) return deadline;
  // Never pull the deadline in — a slow provision must not shorten a boot
  // budget that is already running longer than one poll's worth.
  return Math.max(deadline, Math.min(now + bootBudgetMs, hardDeadline));
}
