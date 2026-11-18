/**
 * Sidecars that survive an instance RESTART.
 *
 * Opt-in per sidecar: the container carries the label `aura.keep-restart=1`
 * (the SDK sets it from `services[].keepAcrossRestart`). When its instance is
 * stopped as part of a restart — or crashes — the sidecar is PARKED instead of
 * reaped: it keeps running until the instance is back (same instance id, so
 * the app's SDK adopts the running container) or the grace deadline passes,
 * after which it is reaped like any other sibling.
 *
 * An explicit stop, kill, force-kill or uninstall reaps at once and drops the
 * park — "cleanup when I kill it" never waits.
 *
 * The parked set is in memory: a shell restart in the middle of an app restart
 * forgets it, and the orphan sweep then reaps the sidecar (its parent is gone)
 * — the safe direction.
 */
export const KEEP_RESTART_LABEL = 'aura.keep-restart';

/**
 * Which sibling containers a restart stop keeps: those labelled
 * `aura.keep-restart=1`, or whose `aura.service` label names a manifest
 * service with `keepAcrossRestart: true` (works with every SDK version, which
 * all set `aura.service`).
 */
export interface KeepSiblings { services: string[]; }

/** The services of a manifest that opted into surviving a restart. */
export function keepServicesOf(manifest: { services?: Array<{ name: string; keepAcrossRestart?: boolean }> } | null | undefined): string[] {
  return (manifest?.services ?? []).filter((s) => s.keepAcrossRestart).map((s) => s.name);
}

/** Does this container (its keep label + service label) survive a restart stop? */
export function keptAcrossRestart(keepLabel: string | undefined, service: string | undefined, keep: KeepSiblings): boolean {
  return keepLabel === '1' || (!!service && keep.services.includes(service));
}

export const DEFAULT_RESTART_GRACE_MS = 3 * 60_000;

export class SidecarParking {
  /** instanceId → deadline (epoch ms). */
  private readonly parked = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  park(instanceId: string, graceMs: number = DEFAULT_RESTART_GRACE_MS): void {
    this.parked.set(instanceId, this.now() + graceMs);
  }

  /** The instance is back (or was stopped for good): stop protecting it. */
  unpark(instanceId: string): boolean {
    return this.parked.delete(instanceId);
  }

  /** Parked and still within its grace. */
  isParked(instanceId: string): boolean {
    const deadline = this.parked.get(instanceId);
    return deadline !== undefined && deadline > this.now();
  }

  /** Parks whose grace ran out, removed from the set (the caller reaps them). */
  takeExpired(): string[] {
    const out: string[] = [];
    const t = this.now();
    for (const [id, deadline] of this.parked) {
      if (deadline <= t) { out.push(id); this.parked.delete(id); }
    }
    return out;
  }

  list(): Array<{ instanceId: string; deadline: number }> {
    return [...this.parked].map(([instanceId, deadline]) => ({ instanceId, deadline }));
  }
}
