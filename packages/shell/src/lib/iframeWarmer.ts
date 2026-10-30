/**
 * Which activity iframes may load, and when.
 *
 * After a reload only the ACTIVE workspace's activities load. Every other
 * activity still gets its slot and an iframe element, but without `src`
 * (the URL waits in `data-src`) until the warmer lets it load:
 *
 *   • 'warm-idle' (default) — once the active workspace has loaded, the rest
 *     load a few at a time while the browser is idle: recently used
 *     workspaces first, then by distance to the active one. Switching to a
 *     workspace that is still cold loads it at once (it jumps the queue).
 *   • 'on-demand' — nothing loads ahead; a workspace loads when it is opened.
 *   • 'eager'     — everything at once (the old behaviour; debug escape hatch).
 *
 * Policy: KV `os/lazyActivities` (Settings → General), overridden per browser
 * by localStorage `aura.lazyActivities` (`off` = eager).
 *
 * Pure bookkeeping: the DOM work (setting `src`) is the caller's `load`.
 */

export type LazyPolicy = 'warm-idle' | 'on-demand' | 'eager';
export const LAZY_KV_KEY = 'lazyActivities';
export const LAZY_STORAGE_KEY = 'aura.lazyActivities';

export function parsePolicy(v: unknown): LazyPolicy | null {
  if (v === 'warm-idle' || v === 'on-demand' || v === 'eager') return v;
  if (v === 'off') return 'eager';
  return null;
}

export interface WarmerDeps {
  /** Give `viewId`'s iframe its src. False when there is nothing to load. */
  load(viewId: string, reason: 'active' | 'warm' | 'switch' | 'eager'): boolean;
  /** Schedule `fn` when the browser is idle. */
  idle(fn: () => void): void;
  /** Wait `ms` (between batches). */
  delay?(fn: () => void, ms: number): void;
  /** True while the page is hidden (warming pauses). */
  isHidden?(): boolean;
  /** Resume after the page becomes visible again. */
  onVisible?(fn: () => void): void;
  /** Timeline hook (bootTimeline.mark). */
  mark?(name: string, detail?: unknown): void;
  batchSize?: number;
  gapMs?: number;
}

export interface IframeWarmer {
  policy(): LazyPolicy;
  setPolicy(p: LazyPolicy): void;
  /** May `viewId`'s iframe have a src now? */
  isWarm(viewId: string): boolean;
  /** The active workspace's views: allowed at once. Returns the ones that were
   *  cold until now (a switch onto a cold workspace). */
  allow(viewIds: Iterable<string>): string[];
  /** Start warming `order` (cold views only; already-warm ones are skipped). */
  start(order: string[]): void;
  /** Forget a closed view. */
  forget(viewId: string): void;
  /** Views still waiting. */
  pending(): string[];
}

export function createIframeWarmer(deps: WarmerDeps): IframeWarmer {
  const warm = new Set<string>();
  let queue: string[] = [];
  let policy: LazyPolicy = 'warm-idle';
  let pumping = false;
  let started = false;
  let batches = 0;
  const batchSize = Math.max(1, deps.batchSize ?? 2);
  const gapMs = deps.gapMs ?? 150;
  const delay = deps.delay ?? ((fn, ms) => { setTimeout(fn, ms); });

  const finish = () => {
    pumping = false;
    deps.mark?.('warm:end', { batches, warm: warm.size });
  };

  const pump = () => {
    if (policy !== 'warm-idle') { pumping = false; return; }
    queue = queue.filter((id) => !warm.has(id));
    if (queue.length === 0) { finish(); return; }
    if (deps.isHidden?.()) {
      // Hidden tab: don't spend the user's machine on a page nobody sees.
      if (deps.onVisible) { deps.onVisible(() => deps.idle(pump)); return; }
    }
    const batch = queue.splice(0, batchSize);
    let loaded = 0;
    for (const id of batch) {
      warm.add(id);
      if (deps.load(id, 'warm')) loaded++;
    }
    batches++;
    deps.mark?.('warm:batch', { n: batches, ids: batch, loaded });
    delay(() => deps.idle(pump), gapMs);
  };

  const kick = () => {
    if (pumping || policy !== 'warm-idle') return;
    pumping = true;
    deps.mark?.('warm:start', { queued: queue.length });
    deps.idle(pump);
  };

  return {
    policy: () => policy,
    setPolicy(p) {
      const prev = policy;
      policy = p;
      if (p === 'eager') {
        for (const id of queue) { warm.add(id); deps.load(id, 'eager'); }
        queue = [];
      } else if (p === 'warm-idle' && prev !== 'warm-idle' && started) {
        kick();
      }
    },
    isWarm: (id) => policy === 'eager' || warm.has(id),
    allow(ids) {
      const cold: string[] = [];
      for (const id of ids) {
        if (!warm.has(id)) { warm.add(id); cold.push(id); }
      }
      if (cold.length) queue = queue.filter((id) => !warm.has(id));
      return cold;
    },
    start(order) {
      started = true;
      const seen = new Set<string>();
      queue = order.filter((id) => !warm.has(id) && !seen.has(id) && (seen.add(id), true));
      if (policy === 'eager') { this.setPolicy('eager'); return; }
      kick();
    },
    forget(id) {
      warm.delete(id);
      queue = queue.filter((q) => q !== id);
    },
    pending: () => queue.filter((id) => !warm.has(id)),
  };
}

export interface WarmOrderInput {
  workspaces: Array<{ id: string; members: string[] }>;
  activeWorkspaceId: string;
  /** Workspace ids, most recently active first (may contain stale ids). */
  recent?: string[];
  /** Activities of the active workspace hidden by its layout (minimized) —
   *  they belong to the current workspace, so they go first. */
  parked?: string[];
}

/**
 * The order the other workspaces' activities warm in: the active workspace's
 * parked activities, then recently used workspaces (most recent first), then
 * the rest by distance to the active one (right neighbour before left), each
 * workspace in its member order.
 */
export function warmOrder(input: WarmOrderInput): string[] {
  const { workspaces, activeWorkspaceId } = input;
  const activeIdx = Math.max(0, workspaces.findIndex((w) => w.id === activeWorkspaceId));
  const others = workspaces.filter((w) => w.id !== activeWorkspaceId);
  const recentRank = new Map<string, number>();
  (input.recent ?? []).forEach((id, i) => { if (!recentRank.has(id)) recentRank.set(id, i); });
  const distance = (w: { id: string }) => {
    const i = workspaces.findIndex((x) => x.id === w.id);
    const d = i - activeIdx;
    // right neighbour (d=+1) before left (d=-1): +1 → 1, -1 → 1.5, +2 → 2 …
    return d > 0 ? d : -d + 0.5;
  };
  const ordered = [...others].sort((a, b) => {
    const ra = recentRank.get(a.id), rb = recentRank.get(b.id);
    if (ra !== undefined || rb !== undefined) {
      if (ra === undefined) return 1;
      if (rb === undefined) return -1;
      return ra - rb;
    }
    return distance(a) - distance(b);
  });
  const out: string[] = [...(input.parked ?? [])];
  for (const w of ordered) out.push(...w.members);
  return out;
}

const RECENT_KEY = 'aura.recentWorkspaces';

/** Remember `wsId` as the most recently active workspace (localStorage). */
export function rememberRecentWorkspace(wsId: string, storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): void {
  if (!storage) return;
  try {
    const cur = JSON.parse(storage.getItem(RECENT_KEY) ?? '[]') as unknown;
    const list = Array.isArray(cur) ? cur.filter((x): x is string => typeof x === 'string' && x !== wsId) : [];
    storage.setItem(RECENT_KEY, JSON.stringify([wsId, ...list].slice(0, 12)));
  } catch { /* storage full / blocked */ }
}

export function recentWorkspaces(storage: Pick<Storage, 'getItem'> | null = safeStorage()): string[] {
  if (!storage) return [];
  try {
    const cur = JSON.parse(storage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(cur) ? cur.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

function safeStorage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}
