/**
 * Interface Registry — the OS's phone book.
 *
 * Apps declare what they PROVIDE (an MCP server, a WS endpoint, a REST path,
 * an event topic, a KV prefix) and what they CONSUME. Anyone can look up who
 * provides what and get a dialable address. Then the OS gets out of the way:
 * provider and consumer talk **directly**.
 *
 * Two rules shape everything here:
 *
 * 1. **Registry, not bus.** This is DNS plus a service catalog — discovery,
 *    description, and (later) permission. It is never in the data path. No
 *    broker, no canonical model, no transform layer. An app that adapts one
 *    interface into another is just an app that consumes A and provides B.
 *
 * 2. **A projection, not a store.** Nothing here is persisted or
 *    independently authoritative. Both layers are derived from live truth and
 *    can be thrown away and rebuilt at any moment:
 *
 *      • CATALOG — what installed apps CAN provide/consume, derived from
 *        manifests on disk (`reload()`). Survives an app being stopped,
 *        because the manifest is the source of truth. This is what will later
 *        let the OS cold-start a provider on demand.
 *
 *      • LIVE — which running instance actually serves what, keyed by
 *        instanceId. Keying by instanceId is the whole design: dropping an
 *        instance is one `Map.delete`, so a runtime registration cannot
 *        outlive the process that opened it — even if the app never calls
 *        `unregister()`. A 5s reconcile in AppManager is the backstop.
 *
 *    Together those close every Windows-Registry failure mode by
 *    construction: nothing to rot, nothing to orphan, nothing that can drift
 *    from what is installed and running.
 *
 * The OS never probes a declared address. If an app says it serves `/mcp` and
 * doesn't, the consumer gets a 404 from the app. A phone book is not a health
 * checker.
 */
import type { AppInstance } from '../types/instance.js';
import type { AppLifecycleState } from '../types/lifecycle.js';
import type {
  AppManifest,
  ConsumedInterface,
  InterfaceKind,
  ProvidedInterface,
} from '../types/manifest.js';

/** Where an entry came from — a manifest declaration, or opened at runtime. */
export type InterfaceSource = 'manifest' | 'runtime';

/**
 * `catalog` — installed and declared, nothing running.
 * `live`    — a running instance serves it; `url` is dialable.
 * `down`    — an instance holds the entry but has no port (or is dying).
 */
export type InterfaceStatus = 'catalog' | 'live' | 'down';

/** The single wire shape shared by core, the API route, the SDK and the UI. */
export interface InterfaceView {
  /** Globally unique ref: `<appId>/<name>`. */
  id: string;
  appId: string;
  name: string;
  kind: InterfaceKind;
  version: string;
  /** As declared. The OS never rewrites it — see `url` for the dialable form. */
  address: string;
  description?: string;
  schema?: string;
  /** Advisory in v1: surfaced, never enforced. */
  permission?: string;
  source: InterfaceSource;
  status: InterfaceStatus;
  /** Present when status is `live` or `down`. */
  instanceId?: string;
  state?: AppLifecycleState;
  /** Dialable address — present only when `live`. Relative: same-origin in an app iframe. */
  url?: string;
  /**
   * Direct host:port, filled in by AppManager (it owns the runners). Lets a
   * node-side consumer skip the shell proxy entirely — the OS is out of the
   * data path either way.
   */
  upstream?: { host: string; port: number } | null;
}

export interface ConsumerView {
  appId: string;
  need: ConsumedInterface;
  /**
   * `live`      — a running provider matches.
   * `installed` — an installed app declares it, but nothing is running.
   * `unmet`     — nothing installed provides it. This is the interesting one:
   *               it is the answer to "why doesn't this composition work?".
   */
  status: 'live' | 'installed' | 'unmet';
  /** Ids of matching providers, best-first. Empty when `unmet`. */
  matches: string[];
}

export interface InterfaceFilter {
  kind?: InterfaceKind;
  appId?: string;
  name?: string;
  /** Only entries currently served by a running instance. */
  live?: boolean;
}

/** Object form of a lookup ref; `name` is required, everything else narrows. */
export interface InterfaceRef {
  appId?: string;
  name: string;
  kind?: InterfaceKind;
  version?: string;
}

type RegisterResult =
  | { ok: true }
  | { ok: false; error: string; status: 404 | 409 };

interface LiveEntry {
  iface: ProvidedInterface;
  source: InterfaceSource;
}

interface LiveRecord {
  /**
   * Snapshot taken at registration. Only a fallback: AppManager REPLACES
   * instance objects on every transition (`upsertInstance` spreads into a new
   * object), so a held reference goes stale within milliseconds. Liveness is
   * therefore read through `lookupInstance` whenever one is available.
   */
  instance: AppInstance;
  entries: Map<string, LiveEntry>;
}

/**
 * Turn a declared address into something a caller can actually dial.
 *
 * Path kinds resolve through the shell's proxy, which is the only address that
 * works from inside an app iframe — and the WS-proxy plugin in the shell's
 * astro config already upgrades WebSockets on exactly that prefix, so `ws`
 * needs no new transport. Deliberately relative: same-origin in the browser,
 * and a node-side caller prefixes `OS_API_BASE` (or uses `upstream` and skips
 * the shell entirely).
 */
export function interfaceUrl(instanceId: string, kind: InterfaceKind, address: string): string {
  if (kind === 'kv')    return `/api/kv/${address.replace(/^\/+/, '')}`;
  if (kind === 'event') return `/api/apps/events?topics=${encodeURIComponent(address)}`;
  return `/api/proxy/${instanceId}${address}`;
}

/** An instance is dialable when it holds a port and isn't dying. */
function isUp(instance: AppInstance): boolean {
  return instance.port !== null
    && instance.state !== 'error'
    && instance.state !== 'destroying'
    && instance.state !== 'destroyed';
}

export class InterfaceRegistry {
  // ── catalog layer — rebuilt wholesale from manifests (cf. IntentResolver) ──
  private provided: Array<{ appId: string; iface: ProvidedInterface }> = [];
  private consumed: Array<{ appId: string; need: ConsumedInterface }> = [];

  // ── live layer — instanceId → what that instance currently serves ─────────
  private live = new Map<string, LiveRecord>();

  /**
   * @param lookupInstance resolves an instanceId to the CURRENT instance
   *   record. Optional so the class stays constructible bare (tests, and the
   *   zero-arg convention the other registries follow), but AppManager always
   *   passes one — without it, liveness would be judged from a snapshot that
   *   went stale at the next state transition.
   */
  constructor(private readonly lookupInstance?: (instanceId: string) => AppInstance | undefined) {}

  // ────────────────────────────── catalog ──────────────────────────────────

  /** Replace the catalog with these manifests' declarations. */
  reload(manifests: readonly AppManifest[]): void {
    const provided: typeof this.provided = [];
    const consumed: typeof this.consumed = [];
    for (const m of manifests) {
      for (const iface of m.provides) provided.push({ appId: m.id, iface });
      for (const need of m.consumes)  consumed.push({ appId: m.id, need });
    }
    this.provided = provided;
    this.consumed = consumed;
  }

  // ─────────────────────────────── live ────────────────────────────────────

  /**
   * Materialise a manifest's `provides` for a newly-live instance.
   *
   * Unconditional at every call site: the pool guard lives HERE so the rule is
   * stated once instead of copied four times. A warm-pool member must never
   * claim an address — it would advertise an instance no user owns.
   */
  registerInstance(instance: AppInstance, manifest: AppManifest | undefined): void {
    if (!manifest || instance.inPool) return;
    if (manifest.provides.length === 0) {
      // Nothing declared. Still drop any stale record for this id so a
      // re-spawn can't inherit the previous occupant's runtime entries.
      this.live.delete(instance.instanceId);
      return;
    }
    const entries = new Map<string, LiveEntry>();
    for (const iface of manifest.provides) {
      entries.set(iface.name, { iface, source: 'manifest' });
    }
    this.live.set(instance.instanceId, { instance, entries });
  }

  /**
   * Drop everything an instance served — manifest-declared and runtime alike.
   * This is the leak-proofing: an app that never calls `unregister()` still
   * cannot outlive its own process.
   */
  unregisterInstance(instance: AppInstance): void {
    this.live.delete(instance.instanceId);
  }

  /** Register an interface an instance opened at runtime. */
  register(instanceId: string, iface: ProvidedInterface): RegisterResult {
    const rec = this.live.get(instanceId);
    if (!rec) {
      return { ok: false, status: 404, error: `No live instance '${instanceId}' to register against` };
    }
    const existing = rec.entries.get(iface.name);
    if (existing?.source === 'manifest') {
      // Shadowing a declaration would make the catalog lie about what the app
      // does — and the manifest is the contract other apps discovered it by.
      return { ok: false, status: 409, error: `'${iface.name}' is declared in the manifest and cannot be overridden at runtime` };
    }
    rec.entries.set(iface.name, { iface, source: 'runtime' });
    return { ok: true };
  }

  /** Best-effort teardown. Returns whether anything was removed. */
  unregister(instanceId: string, name: string): boolean {
    const rec = this.live.get(instanceId);
    const entry = rec?.entries.get(name);
    if (!rec || !entry || entry.source === 'manifest') return false;
    return rec.entries.delete(name);
  }

  /**
   * Force the live layer back into agreement with the instance table. Called
   * on the AppManager heartbeat: principle 2 made operational, so no bug in
   * any register/unregister call site can leave a permanent ghost.
   *
   * @returns how many orphan records were dropped.
   */
  reconcile(liveInstanceIds: ReadonlySet<string>): number {
    let dropped = 0;
    for (const instanceId of [...this.live.keys()]) {
      if (!liveInstanceIds.has(instanceId)) {
        this.live.delete(instanceId);
        dropped++;
      }
    }
    return dropped;
  }

  // ─────────────────────────────── reads ───────────────────────────────────

  /**
   * Every interface the OS knows about: live instances first, then catalog
   * entries for anything declared but not currently served.
   */
  list(filter: InterfaceFilter = {}): InterfaceView[] {
    const views: InterfaceView[] = [];
    /** appId/name pairs already represented by a live record. */
    const covered = new Set<string>();

    for (const [instanceId, rec] of this.live) {
      const instance = this.lookupInstance?.(instanceId) ?? rec.instance;
      const up = isUp(instance);
      for (const { iface, source } of rec.entries.values()) {
        covered.add(`${instance.appId}/${iface.name}`);
        views.push({
          ...toBase(instance.appId, iface),
          source,
          status: up ? 'live' : 'down',
          instanceId,
          state: instance.state,
          ...(up ? { url: interfaceUrl(instanceId, iface.kind, iface.address) } : {}),
        });
      }
    }

    for (const { appId, iface } of this.provided) {
      if (covered.has(`${appId}/${iface.name}`)) continue;
      views.push({ ...toBase(appId, iface), source: 'manifest', status: 'catalog' });
    }

    return views.filter((v) => matches(v, filter));
  }

  /**
   * The single best provider for a ref, or null.
   *
   * Ranking mirrors the proxy's bare-appId rule: a resumed instance beats any
   * other live state, live beats down, and a catalog entry is returned last so
   * a caller can see the app exists but isn't running (rather than being told
   * nothing provides it).
   */
  resolve(ref: string | InterfaceRef): InterfaceView | null {
    const want = typeof ref === 'string' ? parseRef(ref) : ref;
    const candidates = this.list({
      ...(want.appId ? { appId: want.appId } : {}),
      name: want.name,
      ...(want.kind ? { kind: want.kind } : {}),
    }).filter((v) => !want.version || v.version === want.version);

    candidates.sort((a, b) => rank(a) - rank(b));
    return candidates[0] ?? null;
  }

  /** Resolution report for every declared `consumes`. */
  consumers(filter: { appId?: string } = {}): ConsumerView[] {
    const all = this.list();
    const out: ConsumerView[] = [];
    for (const { appId, need } of this.consumed) {
      if (filter.appId && appId !== filter.appId) continue;
      const matched = all
        .filter((v) =>
          v.name === need.name
          && v.kind === need.kind
          && (!need.appId || v.appId === need.appId)
          && (!need.version || v.version === need.version))
        .sort((a, b) => rank(a) - rank(b));
      const status = matched.some((v) => v.status === 'live')
        ? 'live'
        : matched.length > 0 ? 'installed' : 'unmet';
      out.push({ appId, need, status, matches: matched.map((v) => v.id) });
    }
    return out;
  }

  /** Everything, in one call — what the discovery endpoint and the panel want. */
  snapshot(): { interfaces: InterfaceView[]; consumers: ConsumerView[] } {
    return { interfaces: this.list(), consumers: this.consumers() };
  }
}

// ────────────────────────────── helpers ────────────────────────────────────

function toBase(appId: string, iface: ProvidedInterface): Omit<InterfaceView, 'source' | 'status'> {
  return {
    id: `${appId}/${iface.name}`,
    appId,
    name: iface.name,
    kind: iface.kind,
    version: iface.version,
    address: iface.address,
    ...(iface.description ? { description: iface.description } : {}),
    ...(iface.schema      ? { schema: iface.schema }           : {}),
    ...(iface.permission  ? { permission: iface.permission }   : {}),
  };
}

function matches(v: InterfaceView, f: InterfaceFilter): boolean {
  if (f.kind  && v.kind  !== f.kind)  return false;
  if (f.appId && v.appId !== f.appId) return false;
  if (f.name  && v.name  !== f.name)  return false;
  if (f.live  && v.status !== 'live') return false;
  return true;
}

/** Lower is better. */
function rank(v: InterfaceView): number {
  if (v.status === 'live') return v.state === 'resumed' ? 0 : 1;
  if (v.status === 'down') return 2;
  return 3;   // catalog
}

/** `com.acme.api/reviewer` → { appId, name }; a bare `reviewer` → { name }. */
function parseRef(ref: string): InterfaceRef {
  const slash = ref.lastIndexOf('/');
  if (slash <= 0) return { name: ref };
  return { appId: ref.slice(0, slash), name: ref.slice(slash + 1) };
}
