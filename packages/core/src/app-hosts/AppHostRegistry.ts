/**
 * AppHostRegistry: the authority for App Host names (Valkey, private).
 *
 *   apphost:install:<installationId>           STRING JSON AppInstallation
 *   apphost:bind:<scope>:<userId>:<appId>      STRING the app's current installationId
 *   apphost:app:<appId>                        SET    every installationId the app has had
 *   apphost:hosts:<installationId>             HASH   instance scope -> JSON AppHostRecord
 *   apphost:label:<label>                      STRING JSON owner, or a permanent tombstone
 *   apphost:frame:<appId>                      STRING `host` (absent means `proxy`)
 *   apphost:manifest-hosts                     SET    `<appId>|<name>` accepted manifest hosts
 *
 * `apphost:` is not a KvClient namespace, so `/api/kv` can't read or write it
 * (the same protection as `grant:` and `apikey:`).
 *
 * Every mutation reads, decides in TypeScript, then commits through one Lua
 * compare-and-set over all the keys it depends on, retrying on a lost race. A
 * label key is only ever created or turned into a tombstone, never deleted, so
 * a retired name can't be allocated again.
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from '@aura/kv-store';
import type {
  AllocateAppHostInput, AppHostLabelTombstone, AppHostRecord, AppHostRegistry, AppHostResolution,
  AppHostSlotAssignment, AppInstallation, AppInstanceScope, AppSourceFingerprint, ReactivateAppHostInput,
} from './contracts.js';
import {
  MAX_APP_HOST_SLOT, appHostNameForSlot, isValidHostName, proposeAppHostName,
} from './hostRules.js';

export const APP_HOST_PREFIX = 'apphost:';
/** The alpha's one user (D19). */
export const APP_HOST_DEFAULT_USER = 'default';

const installKey = (id: string) => `apphost:install:${id}`;
const bindKey = (appId: string, scope: string, userId: string) => `apphost:bind:${scope}:${userId}:${appId}`;
const appKey = (appId: string) => `apphost:app:${appId}`;
const hostsKey = (id: string) => `apphost:hosts:${id}`;
const labelKey = (label: string) => `apphost:label:${label}`;
const MANIFEST_HOSTS_KEY = 'apphost:manifest-hosts';

const MAX_COMMIT_ATTEMPTS = 256;
/** Proposal retries: the installation id supplies at most 25 suffixes. */
const MAX_NAME_ATTEMPTS = 26;

export function instanceScopeKey(scope: AppInstanceScope): string {
  return scope.kind === 'shared' ? 'shared' : `user:${scope.userId}`;
}

/**
 * The same place, ignoring the version a ref pins: `#ref`, `@sha256:…`, and an
 * image `:tag`. The `@` of an scp-style git URL (`git@host:org/repo`) is part
 * of the place, and only image refs have a tag.
 */
export function sameAppSource(a: AppSourceFingerprint, b: AppSourceFingerprint): boolean {
  const place = (s: AppSourceFingerprint) => {
    const ref = s.ref.trim().replace(/#.*$/, '').replace(/@sha256:[0-9a-f]+$/i, '');
    const name = s.kind === 'oci' || s.kind === 'index' ? ref.replace(/(\/[^/:]+):[^/:]+$/, '$1') : ref;
    return name.replace(/\/+$/, '');
  };
  return a.kind === b.kind && place(a) === place(b);
}

/** A restore that the saved installation record does not support. */
export class AppHostRestoreError extends Error {
  constructor(public readonly code: 'origin-mismatch' | 'source-changed' | 'not-reserved' | 'bound-elsewhere', message: string) {
    super(message);
    this.name = 'AppHostRestoreError';
  }
}

interface Guard { key: string; field?: string; expect: string | null }
type Write =
  | { op: 'set'; key: string; value: string }
  | { op: 'del'; key: string }
  | { op: 'hset'; key: string; field: string; value: string }
  | { op: 'hdel'; key: string; field: string }
  | { op: 'sadd'; key: string; value: string };

/** Checks every guard, then applies every write, as one atomic step. */
const COMMIT = `
local spec = cjson.decode(ARGV[1])
for _, g in ipairs(spec.guards) do
  local cur
  if g.f then cur = redis.call('HGET', KEYS[g.k], g.f) else cur = redis.call('GET', KEYS[g.k]) end
  if g.v == cjson.null then
    if cur then return 0 end
  elseif cur ~= g.v then
    return 0
  end
end
for _, w in ipairs(spec.writes) do
  if w.o == 'set' then redis.call('SET', KEYS[w.k], w.v)
  elseif w.o == 'del' then redis.call('DEL', KEYS[w.k])
  elseif w.o == 'hset' then redis.call('HSET', KEYS[w.k], w.f, w.v)
  elseif w.o == 'hdel' then redis.call('HDEL', KEYS[w.k], w.f)
  elseif w.o == 'sadd' then redis.call('SADD', KEYS[w.k], w.v)
  end
end
return 1
`;

type StoredLabel =
  | { installationId: string; scopeKey: string; slot: number }
  | { tombstone: AppHostLabelTombstone };

export interface AppHostRegistryOpts {
  /** Names manifests hold: a generated name must never equal one. */
  reservedNames?: () => Iterable<string>;
  now?: () => number;
}

export interface NewInstallationInput {
  appId: string;
  originId: string | null;
  scope: string;
  userId?: string;
  source: AppSourceFingerprint;
  /** The installation this one takes the app's binding from. */
  replaces?: string;
  /** How its app processes run (P5-3); see `newInstallationRunAs`. Absent: not recorded (`root`). */
  runAs?: 'root' | 'app';
}

/** The contract plus the installation records the app lifecycle needs. */
export interface AppHostStore extends AppHostRegistry {
  getInstallation(installationId: string): Promise<AppInstallation | null>;
  findInstallation(appId: string, scope: string, userId?: string): Promise<AppInstallation | null>;
  listInstallations(appId: string): Promise<AppInstallation[]>;
  /** Creates the app's installation, or returns the one already bound. */
  createInstallation(input: NewInstallationInput): Promise<AppInstallation>;
  updateInstallation(installationId: string, patch: { originId?: string | null; source?: AppSourceFingerprint }): Promise<AppInstallation>;
  /**
   * The owner's runAs flip of one installation (P5-3), compare-and-set.
   * `expect` is the runAs the caller decided on (absent counts as `root`):
   * a changed record is refused (`{ ok: false }`), never overwritten.
   */
  setRunAs(installationId: string, runAs: 'root' | 'app', expect?: 'root' | 'app'): Promise<{ ok: boolean; installation: AppInstallation | null }>;
  /** `null` until the first boot migration recorded them. */
  getKnownManifestHosts(): Promise<Set<string> | null>;
  addKnownManifestHosts(claims: readonly string[]): Promise<void>;
}

export function createAppHostRegistry(kv: Redis | (() => Redis), opts: AppHostRegistryOpts = {}): AppHostStore {
  const redis = typeof kv === 'function' ? kv : () => kv;
  const now = opts.now ?? Date.now;

  async function commit(guards: Guard[], writes: Write[]): Promise<boolean> {
    const keys: string[] = [];
    const at = (key: string) => {
      let i = keys.indexOf(key);
      if (i < 0) { keys.push(key); i = keys.length - 1; }
      return i + 1;
    };
    const spec = {
      guards: guards.map((g) => ({ k: at(g.key), ...(g.field ? { f: g.field } : {}), v: g.expect })),
      writes: writes.map((w) => ({
        o: w.op, k: at(w.key),
        ...('field' in w ? { f: w.field } : {}),
        ...('value' in w ? { v: w.value } : {}),
      })),
    };
    return (await redis().eval(COMMIT, keys.length, ...keys, JSON.stringify(spec))) === 1;
  }

  /** Runs `step` until it commits. `step` returns undefined after a lost race. */
  async function retry<T>(what: string, step: () => Promise<T | undefined>): Promise<T> {
    for (let i = 0; i < MAX_COMMIT_ATTEMPTS; i++) {
      const out = await step();
      if (out !== undefined) return out;
      if (i > 4) await new Promise((r) => setTimeout(r, Math.random() * Math.min(i, 20)));
    }
    throw new Error(`app host registry: ${what} did not settle`);
  }

  async function readInstallation(id: string): Promise<{ raw: string; value: AppInstallation } | null> {
    const raw = await redis().get(installKey(id));
    return raw ? { raw, value: JSON.parse(raw) as AppInstallation } : null;
  }

  async function readRecords(id: string): Promise<Array<{ field: string; raw: string; value: AppHostRecord }>> {
    const all = await redis().hgetall(hostsKey(id));
    return Object.entries(all).map(([field, raw]) => ({ field, raw, value: JSON.parse(raw) as AppHostRecord }));
  }

  function reservedNameSet(): Set<string> {
    return new Set(opts.reservedNames?.() ?? []);
  }

  /** A manifest host equal to `name`, or to one of its `name`x`N` slot labels. */
  function clashesWithManifest(name: string, reserved: ReadonlySet<string>): boolean {
    if (reserved.has(name)) return true;
    for (const r of reserved) {
      if (r.startsWith(`${name}x`) && /^\d+$/.test(r.slice(name.length + 1))) return true;
    }
    return false;
  }

  const store: AppHostStore = {
    async getInstallation(id) {
      return (await readInstallation(id))?.value ?? null;
    },

    async findInstallation(appId, scope, userId = APP_HOST_DEFAULT_USER) {
      const id = await redis().get(bindKey(appId, scope, userId));
      return id ? store.getInstallation(id) : null;
    },

    async listInstallations(appId) {
      const ids = (await redis().smembers(appKey(appId))).sort();
      const out: AppInstallation[] = [];
      for (const id of ids) {
        const i = await store.getInstallation(id);
        if (i) out.push(i);
      }
      return out;
    },

    async createInstallation(input) {
      const userId = input.userId ?? APP_HOST_DEFAULT_USER;
      const bind = bindKey(input.appId, input.scope, userId);
      return retry('createInstallation', async () => {
        const bound = await redis().get(bind);
        if (bound && bound !== input.replaces) {
          const existing = await store.getInstallation(bound);
          if (existing) return existing;
        }
        if (input.replaces && bound !== input.replaces) {
          throw new Error(`installation ${input.replaces} no longer holds ${input.appId}`);
        }
        const at = now();
        const installation: AppInstallation = {
          installationId: randomUUID(), appId: input.appId, originId: input.originId,
          scope: input.scope, userId, source: input.source, state: 'active',
          ...(input.runAs ? { runAs: input.runAs } : {}),
          createdAt: at, updatedAt: at,
        };
        const ok = await commit(
          [{ key: bind, expect: bound }],
          [
            { op: 'set', key: installKey(installation.installationId), value: JSON.stringify(installation) },
            { op: 'set', key: bind, value: installation.installationId },
            { op: 'sadd', key: appKey(input.appId), value: installation.installationId },
          ],
        );
        return ok ? installation : undefined;
      });
    },

    async updateInstallation(id, patch) {
      return retry('updateInstallation', async () => {
        const cur = await readInstallation(id);
        if (!cur) throw new Error(`unknown installation ${id}`);
        const next: AppInstallation = {
          ...cur.value,
          ...(patch.originId !== undefined ? { originId: patch.originId } : {}),
          ...(patch.source ? { source: patch.source } : {}),
          updatedAt: now(),
        };
        const ok = await commit(
          [{ key: installKey(id), expect: cur.raw }],
          [{ op: 'set', key: installKey(id), value: JSON.stringify(next) }],
        );
        return ok ? next : undefined;
      });
    },

    async setRunAs(id, runAs, expect) {
      if (runAs !== 'root' && runAs !== 'app') throw new Error(`invalid runAs '${String(runAs)}'`);
      const cur = await readInstallation(id);
      if (!cur) return { ok: false, installation: null };
      if (expect !== undefined && (cur.value.runAs ?? 'root') !== expect) return { ok: false, installation: cur.value };
      if ((cur.value.runAs ?? 'root') === runAs && cur.value.runAs !== undefined) return { ok: true, installation: cur.value };
      const next: AppInstallation = { ...cur.value, runAs, updatedAt: now() };
      const ok = await commit(
        [{ key: installKey(id), expect: cur.raw }],
        [{ op: 'set', key: installKey(id), value: JSON.stringify(next) }],
      );
      return ok ? { ok: true, installation: next } : { ok: false, installation: (await readInstallation(id))?.value ?? null };
    },

    async allocate({ installation, instanceScope, isSystemApp }) {
      const id = installation.installationId;
      const field = instanceScopeKey(instanceScope);
      return retry('allocate', async () => {
        const stored = await readInstallation(id);
        if (stored && stored.value.state === 'retired') throw new Error(`installation ${id} is retired`);
        const existing = await redis().hget(hostsKey(id), field);
        if (existing) return JSON.parse(existing) as AppHostRecord;
        if (stored && stored.value.state !== 'active') throw new Error(`installation ${id} is ${stored.value.state}`);
        const current = stored?.value ?? installation;
        const reserved = reservedNameSet();

        for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
          let name: string;
          try {
            name = proposeAppHostName({
              appId: current.appId, originId: current.originId, installationId: id, isSystemApp, attempt,
            });
          } catch (err) {
            if (err instanceof RangeError) break;
            throw err;
          }
          if (!isValidHostName(name) || clashesWithManifest(name, reserved)) continue;
          if (await redis().exists(labelKey(name))) continue;
          const at = now();
          const record: AppHostRecord = {
            installationId: id, appId: current.appId, instanceScope, baseName: name, state: 'active',
            slots: [{ slot: 1, label: name, instanceId: null, assignedAt: null }], createdAt: at,
          };
          const stateGuard: Guard = { key: installKey(id), expect: stored?.raw ?? null };
          const ok = await commit(
            [stateGuard, { key: hostsKey(id), field, expect: null }, { key: labelKey(name), expect: null }],
            [
              ...(stored ? [] : [{ op: 'set', key: installKey(id), value: JSON.stringify(installation) } as Write]),
              { op: 'sadd', key: appKey(current.appId), value: id },
              { op: 'hset', key: hostsKey(id), field, value: JSON.stringify(record) },
              { op: 'set', key: labelKey(name), value: JSON.stringify({ installationId: id, scopeKey: field, slot: 1 } satisfies StoredLabel) },
            ],
          );
          if (ok) return record;
          return undefined;
        }
        throw new Error(`no free app host name for ${current.appId}`);
      });
    },

    async resolveLabel(rawLabel) {
      const label = rawLabel.trim().toLowerCase();
      if (!isValidHostName(label)) return { status: 'unknown' };
      const raw = await redis().get(labelKey(label));
      if (!raw) return { status: 'unknown' };
      const stored = JSON.parse(raw) as StoredLabel;
      if ('tombstone' in stored) return { status: 'retired', tombstone: stored.tombstone };
      const recRaw = await redis().hget(hostsKey(stored.installationId), stored.scopeKey);
      if (!recRaw) return { status: 'unknown' };
      const record = JSON.parse(recRaw) as AppHostRecord;
      const slot = record.slots.find((s) => s.label === label);
      if (!slot) return { status: 'unknown' };
      return { status: record.state, record, slot } as AppHostResolution;
    },

    async reserve(id) {
      await retry('reserve', async () => {
        const cur = await readInstallation(id);
        if (!cur) throw new Error(`unknown installation ${id}`);
        if (cur.value.state === 'retired') throw new Error(`installation ${id} is retired`);
        const records = await readRecords(id);
        if (cur.value.state === 'reserved' && records.every((r) => r.value.state === 'reserved')) return true;
        const next: AppInstallation = { ...cur.value, state: 'reserved', updatedAt: now() };
        const ok = await commit(
          [{ key: installKey(id), expect: cur.raw }, ...records.map((r) => ({ key: hostsKey(id), field: r.field, expect: r.raw }))],
          [
            { op: 'set', key: installKey(id), value: JSON.stringify(next) },
            ...records.map((r): Write => ({
              op: 'hset', key: hostsKey(id), field: r.field,
              value: JSON.stringify({
                ...r.value, state: 'reserved',
                slots: r.value.slots.map((s) => ({ ...s, instanceId: null, assignedAt: null })),
              } satisfies AppHostRecord),
            })),
          ],
        );
        return ok ? true : undefined;
      });
    },

    async reactivate(input) {
      const id = input.installationId;
      return retry('reactivate', async () => {
        const cur = await readInstallation(id);
        if (!cur || cur.value.state === 'retired') throw new AppHostRestoreError('not-reserved', `installation ${id} cannot be restored`);
        if ((cur.value.originId ?? null) !== (input.originId ?? null)) {
          throw new AppHostRestoreError('origin-mismatch', `installation ${id} belongs to another originId`);
        }
        if (!sameAppSource(cur.value.source, input.source) && !input.confirmedSourceChange) {
          throw new AppHostRestoreError('source-changed', `the source of ${cur.value.appId} changed: the restore needs confirmation`);
        }
        const records = await readRecords(id);
        if (cur.value.state === 'active') return records.map((r) => r.value);
        const bind = bindKey(cur.value.appId, cur.value.scope, cur.value.userId);
        const bound = await redis().get(bind);
        if (bound && bound !== id) {
          const holder = await store.getInstallation(bound);
          if (holder?.state === 'active') {
            throw new AppHostRestoreError('bound-elsewhere', `${cur.value.appId} is held by another active installation`);
          }
        }
        const next: AppInstallation = { ...cur.value, source: input.source, state: 'active', updatedAt: now() };
        const nextRecords = records.map((r) => ({ ...r, value: { ...r.value, state: 'active' } as AppHostRecord }));
        const ok = await commit(
          [
            { key: installKey(id), expect: cur.raw }, { key: bind, expect: bound },
            ...records.map((r) => ({ key: hostsKey(id), field: r.field, expect: r.raw })),
          ],
          [
            { op: 'set', key: installKey(id), value: JSON.stringify(next) },
            { op: 'set', key: bind, value: id },
            ...nextRecords.map((r): Write => ({ op: 'hset', key: hostsKey(id), field: r.field, value: JSON.stringify(r.value) })),
          ],
        );
        return ok ? nextRecords.map((r) => r.value) : undefined;
      });
    },

    async retire(id) {
      return retry('retire', async () => {
        const cur = await readInstallation(id);
        if (!cur) throw new Error(`unknown installation ${id}`);
        const records = await readRecords(id);
        if (cur.value.state === 'retired' && records.length === 0) return [];
        const at = now();
        const tombstones = records.flatMap((r) => r.value.slots.map((s): AppHostLabelTombstone => ({
          label: s.label, installationId: id, appId: cur.value.appId, retiredAt: at,
        })));
        const bind = bindKey(cur.value.appId, cur.value.scope, cur.value.userId);
        const bound = await redis().get(bind);
        const next: AppInstallation = { ...cur.value, state: 'retired', updatedAt: at };
        const ok = await commit(
          [
            { key: installKey(id), expect: cur.raw }, { key: bind, expect: bound },
            ...records.map((r) => ({ key: hostsKey(id), field: r.field, expect: r.raw })),
          ],
          [
            { op: 'set', key: installKey(id), value: JSON.stringify(next) },
            ...(bound === id ? [{ op: 'del', key: bind } as Write] : []),
            ...tombstones.map((t): Write => ({ op: 'set', key: labelKey(t.label), value: JSON.stringify({ tombstone: t } satisfies StoredLabel) })),
            { op: 'del', key: hostsKey(id) },
          ],
        );
        return ok ? tombstones : undefined;
      });
    },

    async assignSlot(id, instanceScope, instanceId) {
      const field = instanceScopeKey(instanceScope);
      return retry('assignSlot', async () => {
        const raw = await redis().hget(hostsKey(id), field);
        if (!raw) throw new Error(`installation ${id} has no hosts in scope ${field}`);
        const record = JSON.parse(raw) as AppHostRecord;
        if (record.state !== 'active') throw new Error(`installation ${id} is ${record.state}`);
        const held = record.slots.find((s) => s.instanceId === instanceId);
        if (held) return held;

        const bySlot = new Map(record.slots.map((s) => [s.slot, s]));
        const reserved = reservedNameSet();
        for (let n = 1; n <= MAX_APP_HOST_SLOT; n++) {
          const have = bySlot.get(n);
          if (have && have.instanceId !== null) continue;
          const label = have?.label ?? appHostNameForSlot(record.baseName, n);
          // A label outside this record belongs to someone else, or is retired.
          if (!have && (reserved.has(label) || await redis().exists(labelKey(label)))) continue;
          const slot: AppHostSlotAssignment = { slot: n, label, instanceId, assignedAt: now() };
          const slots = [...record.slots.filter((s) => s.slot !== n), slot].sort((a, b) => a.slot - b.slot);
          const ok = await commit(
            [
              { key: hostsKey(id), field, expect: raw },
              ...(have ? [] : [{ key: labelKey(label), expect: null } as Guard]),
            ],
            [
              { op: 'hset', key: hostsKey(id), field, value: JSON.stringify({ ...record, slots } satisfies AppHostRecord) },
              ...(have ? [] : [{
                op: 'set', key: labelKey(label),
                value: JSON.stringify({ installationId: id, scopeKey: field, slot: n } satisfies StoredLabel),
              } as Write]),
            ],
          );
          return ok ? slot : undefined;
        }
        throw new Error(`no free app host slot for ${record.appId}`);
      });
    },

    async releaseSlot(id, instanceScope, instanceId) {
      const field = instanceScopeKey(instanceScope);
      await retry('releaseSlot', async () => {
        const raw = await redis().hget(hostsKey(id), field);
        if (!raw) return true;
        const record = JSON.parse(raw) as AppHostRecord;
        if (!record.slots.some((s) => s.instanceId === instanceId)) return true;
        const slots = record.slots.map((s) => (s.instanceId === instanceId ? { ...s, instanceId: null, assignedAt: null } : s));
        const ok = await commit(
          [{ key: hostsKey(id), field, expect: raw }],
          [{ op: 'hset', key: hostsKey(id), field, value: JSON.stringify({ ...record, slots } satisfies AppHostRecord) }],
        );
        return ok ? true : undefined;
      });
    },

    async listForApp(appId) {
      const ids = (await redis().smembers(appKey(appId))).sort();
      const out: AppHostRecord[] = [];
      for (const id of ids) out.push(...(await readRecords(id)).map((r) => r.value));
      return out;
    },

    async getKnownManifestHosts() {
      const r = redis();
      if (!(await r.exists(MANIFEST_HOSTS_KEY))) return null;
      return new Set((await r.smembers(MANIFEST_HOSTS_KEY)).filter((c) => c !== ''));
    },

    async addKnownManifestHosts(claims) {
      // The empty member marks "recorded" for an install with no manifest hosts.
      await redis().sadd(MANIFEST_HOSTS_KEY, '', ...claims);
    },
  };
  return store;
}
