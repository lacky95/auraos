/**
 * ApiKeyStore — admin-issued keys for external REST callers.
 *
 *   key format   aura_k1_<id: 16 hex>_<secret: 43 base64url>
 *                shown ONCE at creation, never stored
 *   apikey:<id>  JSON ApiKeyRecord (name, scopes, sha256(secret), timestamps)
 *   apikey:idx   ZSET id → createdAt
 *   apikey:used  HASH id → lastUsedAt (separate, so a usage write can never
 *                race a revoke and resurrect the key)
 *
 * The secret is 256 random bits, so a plain sha256 is a sufficient hash
 * (no password stretching needed); verification is a constant-time compare.
 * Revoked keys keep their record (audit), and stop verifying immediately.
 * `apikey:` is not a KvClient namespace, so `/api/kv` can't reach it.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Redis } from '@aura/kv-store';
import type { AdminAttribution } from './types.js';

export const API_KEY_PREFIX = 'aura_k1_';
export const API_KEY_INDEX = 'apikey:idx';
export const API_KEY_USED = 'apikey:used';
export const apiKeyRecordKey = (id: string) => `apikey:${id}`;
export const API_KEY_PATTERN = /^aura_k1_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

/** Scopes a key can carry (permission names). */
export const API_KEY_SCOPES: readonly string[] = ['system.notifications', 'notifications.locked', 'notifications.popup'];

/** `lastUsedAt` is written at most this often per key. */
const LAST_USED_RESOLUTION_MS = 60_000;

export interface ApiKeyRecord {
  id: string;
  name: string;
  scopes: string[];
  createdAt: number;
  createdBy: AdminAttribution | { kind: 'system' };
  lastUsedAt?: number;
  revokedAt?: number;
}

interface StoredKey extends ApiKeyRecord { hash: string }

export class ApiKeyError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiKeyError';
  }
}

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function publicOf(rec: StoredKey): ApiKeyRecord {
  const { hash: _h, ...pub } = rec;
  return pub;
}

function withUsed(rec: ApiKeyRecord, used: string | null | undefined): ApiKeyRecord {
  return used ? { ...rec, lastUsedAt: Number(used) } : rec;
}

export function looksLikeApiKey(s: string): boolean {
  return s.startsWith(API_KEY_PREFIX);
}

export class ApiKeyStore {
  private readonly lastUsed = new Map<string, number>();

  constructor(private readonly redis: () => Redis, private readonly now: () => number = Date.now) {}

  /** Create a key. `key` is returned ONCE — only its hash is stored. */
  async create(input: { name: string; scopes: string[]; by: ApiKeyRecord['createdBy'] }): Promise<{ key: string; apiKey: ApiKeyRecord }> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 100) throw new ApiKeyError(400, 'name is required (1–100 chars)');
    const scopes = [...new Set(input.scopes ?? [])];
    if (scopes.length === 0) throw new ApiKeyError(400, `at least one scope is required — one of ${API_KEY_SCOPES.join(', ')}`);
    const bad = scopes.filter((s) => !API_KEY_SCOPES.includes(s));
    if (bad.length) throw new ApiKeyError(400, `unknown scope(s) ${bad.join(', ')} — allowed: ${API_KEY_SCOPES.join(', ')}`);

    const id = randomBytes(8).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    const key = `${API_KEY_PREFIX}${id}_${secret}`;
    const rec: StoredKey = { id, name, scopes, createdAt: this.now(), createdBy: input.by, hash: sha256hex(secret) };
    const r = this.redis();
    const ok = await r.set(apiKeyRecordKey(id), JSON.stringify(rec), 'NX');
    if (ok !== 'OK') throw new ApiKeyError(500, 'key id collision — retry');
    await r.zadd(API_KEY_INDEX, rec.createdAt, id);
    return { key, apiKey: publicOf(rec) };
  }

  /** The key's record if `key` is valid and not revoked, else null. Never throws on bad input. */
  async verify(key: string | null | undefined): Promise<ApiKeyRecord | null> {
    if (!key) return null;
    const m = API_KEY_PATTERN.exec(key);
    if (!m) return null;
    const [, id, secret] = m as unknown as [string, string, string];
    const raw = await this.redis().get(apiKeyRecordKey(id));
    if (!raw) return null;
    const rec = JSON.parse(raw) as StoredKey;
    const a = Buffer.from(sha256hex(secret), 'hex');
    const b = Buffer.from(rec.hash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (rec.revokedAt !== undefined) return null;
    const now = this.now();
    const last = this.lastUsed.get(id) ?? 0;
    if (now - last >= LAST_USED_RESOLUTION_MS) {
      this.lastUsed.set(id, now);
      // Best effort; never block or fail a request on it.
      void this.redis().hset(API_KEY_USED, id, String(now)).catch(() => undefined);
    }
    return { ...publicOf(rec), lastUsedAt: now };
  }

  async get(id: string): Promise<ApiKeyRecord | null> {
    if (!/^[0-9a-f]{16}$/.test(id)) return null;
    const r = this.redis();
    const [raw, used] = await Promise.all([r.get(apiKeyRecordKey(id)), r.hget(API_KEY_USED, id)]);
    return raw ? withUsed(publicOf(JSON.parse(raw) as StoredKey), used) : null;
  }

  /** Newest first, revoked ones included (with `revokedAt`). */
  async list(): Promise<ApiKeyRecord[]> {
    const r = this.redis();
    const ids = await r.zrevrange(API_KEY_INDEX, 0, -1);
    if (ids.length === 0) return [];
    const [raws, used] = await Promise.all([r.mget(...ids.map(apiKeyRecordKey)), r.hgetall(API_KEY_USED)]);
    return raws.filter((x): x is string => !!x).map((x) => {
      const rec = publicOf(JSON.parse(x) as StoredKey);
      return withUsed(rec, used[rec.id]);
    });
  }

  /** Revoke: the key stops verifying at once. Returns the record, or null if unknown. */
  async revoke(id: string): Promise<ApiKeyRecord | null> {
    if (!/^[0-9a-f]{16}$/.test(id)) return null;
    const r = this.redis();
    const raw = await r.get(apiKeyRecordKey(id));
    if (!raw) return null;
    const rec = JSON.parse(raw) as StoredKey;
    if (rec.revokedAt === undefined) {
      rec.revokedAt = this.now();
      await r.set(apiKeyRecordKey(id), JSON.stringify(rec));
    }
    return publicOf(rec);
  }
}
