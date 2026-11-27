/**
 * The personal vault (D56, Q31): each user's credentials, kept on the Aura
 * Context store and keyed by `userId`, never as files in a home.
 *
 *   context:user:<userId>   <NAME> → { kind: 'secret', sealed, inject: [], credential }
 *
 * An entry is a Context entry injected nowhere by itself (`inject: []`):
 * sealed with the Context master key (seal.ts), never materialised as a file.
 * It reaches an app's env or `osClient.context.get` only when the app
 * declares the name in `context[]` AND holds this user's raw-read grant
 * (context/grantedContext.ts, Phase 5 stream C); each such read is audited.
 * `credential` holds what the owner sees about it: who may hold a handle
 * (`consumers`), and when it was last used.
 *
 * A **handle** (`cred_…`) names one entry for one consuming app of one user.
 * It is what a requester gets back (`osClient.credentials.request`), and it
 * is not the value: reading the value needs, on top, the owner's separate
 * `credential.read:<NAME>` grant to that app (GrantStore, scope `user`). A
 * handle resolves only in its own user's vault, so another user's handle is
 * simply unknown.
 *
 * A **generated setup secret** (D108 `secret.source: generate`) is made by
 * the vault itself for one (installation, field) of an app, never typed by
 * anyone: `generate()` keeps it under a reserved name
 * (`AURA_SETUP_<digest>`, `setupSecretName`) in the installation owner's
 * vault, bound to that installation, with exactly one consumer (the app).
 * It is idempotent per (installation, field), can't be replaced by `store`,
 * and goes away entirely when its app's handle is revoked (delete-app-data,
 * setup/store.ts `forgetInstallation` → `removeConsumer`).
 *
 * Nothing here logs, and no listing carries a value or a handle.
 */
import { createHash, randomBytes } from 'node:crypto';
import { defaultKv, type KvNamespace } from '@aura/kv-store';
import { open, resolveMasterKey, seal } from './seal.js';

/** Credential names are Context key names, so `osClient.context.get(NAME)` can read a granted one. */
export const CREDENTIAL_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const CREDENTIAL_HANDLE_PREFIX = 'cred_';
/** `cred_` + 22 base64url characters (128 random bits). */
export const CREDENTIAL_HANDLE_RE = /^cred_[A-Za-z0-9_-]{22}$/;
/** The longest value the vault keeps, in UTF-8 bytes. */
export const MAX_CREDENTIAL_BYTES = 4096;
const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_LABEL = 80;

export const isCredentialName = (v: unknown): v is string => typeof v === 'string' && CREDENTIAL_NAME_RE.test(v);
export const isCredentialHandle = (v: unknown): v is string => typeof v === 'string' && CREDENTIAL_HANDLE_RE.test(v);

/** The vault's KV namespace for one user. */
export function credentialNamespace(userId: string): KvNamespace {
  if (!USER_ID_RE.test(userId)) throw new Error('invalid user id');
  return `context:user:${userId}`;
}

interface Consumer { handle: string; since: number }

/** The installation and setup field a generated secret is bound to (D108). */
export interface SetupSecretBinding { installationId: string; field: string }

interface CredentialMeta {
  label?: string;
  /** Set only on a generated setup secret: whose it is. */
  installation?: SetupSecretBinding;
  createdAt: number;
  updatedAt: number;
  consumers: Record<string, Consumer>;
  lastUsedAt?: number;
  lastUsedBy?: string;
}

interface StoredCredential {
  kind: 'secret';
  sealed: string;
  /** Always empty: a vault entry reaches no app by injection. */
  inject: [];
  credential: CredentialMeta;
}

/** What the owner sees of one credential: never its value, never a handle. */
export interface CredentialSummary {
  name: string;
  label?: string;
  createdAt: number;
  updatedAt: number;
  /** The apps that hold a handle, oldest first. */
  consumers: Array<{ appId: string; since: number }>;
  lastUsedAt?: number;
  lastUsedBy?: string;
}

/** The part of `KvClient` the vault uses. */
export interface VaultKv {
  get(ns: KvNamespace | string, key: string): Promise<{ value: unknown; updatedAt?: number } | null>;
  set(ns: KvNamespace | string, key: string, value: unknown): Promise<unknown>;
  del(ns: KvNamespace | string, key: string): Promise<boolean>;
  list(ns: KvNamespace | string, opts?: { limit?: number }): Promise<string[]>;
  close?(): Promise<unknown>;
}

export interface CredentialVaultOptions {
  /** A KV client per operation (closed after it); default `defaultKv()`. */
  kv?: () => VaultKv;
  /** The sealing key; default the Context master key. */
  key?: Buffer;
  dataDir?: string;
  now?: () => number;
}

const newHandle = (): string => CREDENTIAL_HANDLE_PREFIX + randomBytes(16).toString('base64url');

function assertName(name: string): void {
  if (!CREDENTIAL_NAME_RE.test(name)) throw new Error(`invalid credential name — must match ${CREDENTIAL_NAME_RE.source}`);
}

function assertApp(appId: string): void {
  if (!APP_ID_RE.test(appId)) throw new Error('invalid app id');
}

/** A stored entry, or null for anything that is not one. */
function parse(raw: unknown): StoredCredential | null {
  const s = raw as Partial<StoredCredential> | null;
  if (!s || typeof s !== 'object' || typeof s.sealed !== 'string' || !s.credential || typeof s.credential !== 'object') return null;
  const c = s.credential;
  return {
    kind: 'secret', sealed: s.sealed, inject: [],
    credential: {
      ...(typeof c.label === 'string' ? { label: c.label } : {}),
      createdAt: Number(c.createdAt) || 0,
      updatedAt: Number(c.updatedAt) || 0,
      consumers: c.consumers && typeof c.consumers === 'object' ? { ...c.consumers } : {},
      ...(typeof c.lastUsedAt === 'number' ? { lastUsedAt: c.lastUsedAt } : {}),
      ...(typeof c.lastUsedBy === 'string' ? { lastUsedBy: c.lastUsedBy } : {}),
      ...(bindingOf(c.installation) ? { installation: bindingOf(c.installation)! } : {}),
    },
  };
}

function bindingOf(raw: unknown): SetupSecretBinding | null {
  const b = raw as Partial<SetupSecretBinding> | null | undefined;
  return b && typeof b === 'object' && typeof b.installationId === 'string' && typeof b.field === 'string'
    ? { installationId: b.installationId, field: b.field } : null;
}

/** The reserved name prefix of generated setup secrets: `store` never writes one. */
export const SETUP_SECRET_PREFIX = 'AURA_SETUP_';
const SETUP_FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * The vault name of the generated secret of (installation, field): fixed, so
 * `generate` is idempotent, and opaque (no app id or field name in a key).
 */
export function setupSecretName(installationId: string, field: string): string {
  return SETUP_SECRET_PREFIX + createHash('sha256').update(`${installationId}\0${field}`).digest('hex').slice(0, 32).toUpperCase();
}

/** `length` random characters (base64url alphabet, 6 bits each). */
function randomSecret(length: number): string {
  return randomBytes(Math.ceil((length * 6) / 8) + 1).toString('base64url').slice(0, length);
}

/** One generate at a time per vault entry in this process (no lost handle between two concurrent first calls). */
const generating = new Map<string, Promise<unknown>>();

function summary(name: string, s: StoredCredential): CredentialSummary {
  const c = s.credential;
  return {
    name,
    ...(c.label ? { label: c.label } : {}),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    consumers: Object.entries(c.consumers)
      .map(([appId, v]) => ({ appId, since: v.since }))
      .sort((a, b) => a.since - b.since || a.appId.localeCompare(b.appId)),
    ...(c.lastUsedAt !== undefined ? { lastUsedAt: c.lastUsedAt } : {}),
    ...(c.lastUsedBy !== undefined ? { lastUsedBy: c.lastUsedBy } : {}),
  };
}

export class CredentialVault {
  private readonly kv: () => VaultKv;
  private readonly sealKey: () => Buffer;
  private readonly now: () => number;

  constructor(opts: CredentialVaultOptions = {}) {
    this.kv = opts.kv ?? (() => defaultKv() as unknown as VaultKv);
    const dataDir = opts.dataDir ?? process.env['AURA_DATA_DIR'] ?? '/data';
    this.sealKey = opts.key ? () => opts.key! : () => resolveMasterKey(dataDir);
    this.now = opts.now ?? Date.now;
  }

  private async with<T>(fn: (kv: VaultKv) => Promise<T>): Promise<T> {
    const kv = this.kv();
    try {
      return await fn(kv);
    } finally {
      await kv.close?.().catch(() => undefined);
    }
  }

  private async load(kv: VaultKv, userId: string, name: string): Promise<StoredCredential | null> {
    return parse((await kv.get(credentialNamespace(userId), name))?.value);
  }

  /**
   * Keep `value` as `name` for `userId` (replacing an earlier value), with a
   * handle for `consumer`. An app that already holds a handle keeps it.
   */
  async store(
    userId: string, name: string, value: string, opts: { consumer: string; label?: string },
  ): Promise<{ handle: string; created: boolean }> {
    assertName(name);
    assertApp(opts.consumer);
    if (name.startsWith(SETUP_SECRET_PREFIX)) throw new Error(`credential names starting ${SETUP_SECRET_PREFIX} are reserved for generated setup secrets`);
    if (typeof value !== 'string' || value.length === 0) throw new Error('empty credential');
    if (Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_BYTES) throw new Error('credential too long');
    const ns = credentialNamespace(userId);
    return this.with(async (kv) => {
      const prev = await this.load(kv, userId, name);
      if (prev?.credential.installation) throw new Error('a generated setup secret cannot be replaced');
      const at = this.now();
      const consumers = { ...(prev?.credential.consumers ?? {}) };
      const held = consumers[opts.consumer];
      const handle = held?.handle ?? newHandle();
      if (!held) consumers[opts.consumer] = { handle, since: at };
      const label = typeof opts.label === 'string' ? opts.label.slice(0, MAX_LABEL) : prev?.credential.label;
      const entry: StoredCredential = {
        kind: 'secret', sealed: seal(value, this.sealKey()), inject: [],
        credential: {
          ...(label ? { label } : {}),
          createdAt: prev?.credential.createdAt ?? at,
          updatedAt: at,
          consumers,
          ...(prev?.credential.lastUsedAt !== undefined ? { lastUsedAt: prev.credential.lastUsedAt } : {}),
          ...(prev?.credential.lastUsedBy !== undefined ? { lastUsedBy: prev.credential.lastUsedBy } : {}),
        },
      };
      await kv.set(ns, name, entry);
      return { handle, created: !prev };
    });
  }

  /** Every credential of `userId`, by name. No values, no handles. */
  async list(userId: string): Promise<CredentialSummary[]> {
    const ns = credentialNamespace(userId);
    return this.with(async (kv) => {
      const out: CredentialSummary[] = [];
      for (const name of await kv.list(ns, { limit: 1000 })) {
        if (!CREDENTIAL_NAME_RE.test(name)) continue;
        const s = parse((await kv.get(ns, name))?.value);
        if (s) out.push(summary(name, s));
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  /**
   * D108: the generated secret of (`installationId`, `field`) for `consumer`
   * (the installation's app), kept in `userId`'s vault (the installation
   * owner's). Creates `length` random characters the first time; afterwards
   * returns the same handle (`created: false`). The value never leaves the
   * vault here. Refuses a reserved name that holds anything else.
   */
  async generate(
    userId: string, opts: { consumer: string; installationId: string; field: string; length?: number; label?: string },
  ): Promise<{ handle: string; created: boolean }> {
    assertApp(opts.consumer);
    if (typeof opts.installationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(opts.installationId)) throw new Error('invalid installation id');
    if (!SETUP_FIELD_RE.test(opts.field)) throw new Error('invalid setup field name');
    const length = opts.length ?? 32;
    if (!Number.isInteger(length) || length < 16 || length > 256) throw new Error('generated secret length must be 16..256');
    const ns = credentialNamespace(userId);
    const name = setupSecretName(opts.installationId, opts.field);
    const key = `${ns}|${name}`;
    const prior = generating.get(key) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(() => this.with(async (kv) => {
      const prev = await this.load(kv, userId, name);
      if (prev) {
        const b = prev.credential.installation;
        const held = prev.credential.consumers[opts.consumer];
        if (!b || b.installationId !== opts.installationId || b.field !== opts.field || !held) {
          throw new Error('the reserved name of this setup secret holds another entry');
        }
        return { handle: held.handle, created: false };
      }
      const at = this.now();
      const handle = newHandle();
      const label = (opts.label ?? `Generated for ${opts.consumer} (setup field ${opts.field})`).slice(0, MAX_LABEL);
      const entry: StoredCredential = {
        kind: 'secret', sealed: seal(randomSecret(length), this.sealKey()), inject: [],
        credential: {
          label, createdAt: at, updatedAt: at, consumers: { [opts.consumer]: { handle, since: at } },
          installation: { installationId: opts.installationId, field: opts.field },
        },
      };
      await kv.set(ns, name, entry);
      return { handle, created: true };
    }));
    generating.set(key, run);
    try { return await run; } finally { if (generating.get(key) === run) generating.delete(key); }
  }

  /** The summary of one credential, or null. */
  async describe(userId: string, name: string): Promise<CredentialSummary | null> {
    assertName(name);
    return this.with(async (kv) => {
      const s = await this.load(kv, userId, name);
      return s ? summary(name, s) : null;
    });
  }

  /** The handle `appId` holds for `name`, or null. */
  async handleOf(userId: string, name: string, appId: string): Promise<string | null> {
    assertName(name);
    return this.with(async (kv) => (await this.load(kv, userId, name))?.credential.consumers[appId]?.handle ?? null);
  }

  /** What a handle names in `userId`'s vault: the credential and the app holding it. Null when unknown there. */
  async resolve(userId: string, handle: string): Promise<{ name: string; consumer: string; installation?: SetupSecretBinding } | null> {
    if (!CREDENTIAL_HANDLE_RE.test(handle)) return null;
    const ns = credentialNamespace(userId);
    return this.with(async (kv) => {
      for (const name of await kv.list(ns, { limit: 1000 })) {
        if (!CREDENTIAL_NAME_RE.test(name)) continue;
        const s = parse((await kv.get(ns, name))?.value);
        const hit = s && Object.entries(s.credential.consumers).find(([, c]) => c.handle === handle);
        if (hit) return { name, consumer: hit[0], ...(s.credential.installation ? { installation: { ...s.credential.installation } } : {}) };
      }
      return null;
    });
  }

  /**
   * The value of `name` for `appId`, recorded as its last use. Server-internal:
   * the caller has checked the app's `credential.read:<name>` grant.
   */
  async reveal(userId: string, name: string, appId: string): Promise<string | null> {
    assertName(name);
    return this.with(async (kv) => {
      const s = await this.load(kv, userId, name);
      if (!s) return null;
      const value = open(s.sealed, this.sealKey());
      s.credential.lastUsedAt = this.now();
      s.credential.lastUsedBy = appId;
      await kv.set(credentialNamespace(userId), name, s);
      return value;
    });
  }

  /**
   * `appId` no longer holds a handle for `name`. Whether it held one. A
   * generated setup secret has no other consumer and no owner who typed it:
   * it is removed entirely.
   */
  async removeConsumer(userId: string, name: string, appId: string): Promise<boolean> {
    assertName(name);
    return this.with(async (kv) => {
      const s = await this.load(kv, userId, name);
      if (!s || !s.credential.consumers[appId]) return false;
      if (s.credential.installation) { await kv.del(credentialNamespace(userId), name); return true; }
      delete s.credential.consumers[appId];
      await kv.set(credentialNamespace(userId), name, s);
      return true;
    });
  }

  /** Remove the credential and every handle to it. Whether it existed. */
  async remove(userId: string, name: string): Promise<boolean> {
    assertName(name);
    return this.with((kv) => kv.del(credentialNamespace(userId), name));
  }
}
