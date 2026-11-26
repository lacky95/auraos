/**
 * Per-user data in the KV (D46, owner answer #8, F0):
 *
 *   user/<userId>/prefs : <key>     the user's preferences (theme and mode,
 *                                   locale, keymap, workspaces, app MRU,
 *                                   desktop session). Were shared `os/<key>`.
 *   app/<appId>/u/<userId> : <key>  an app's storage for one user (default)
 *   app/<appId>/shared : <key>      an app's storage for all its users (opt-in)
 *
 * The user always comes from the verified caller, never from the app.
 *
 * Migration (once, after a backup): today's `os/<pref>` values and every
 * `app/<appId>` key are copied into the owner's area. The old values stay
 * where they are, and for one release every read falls back to them, so
 * nothing written before the migration is lost and a rollback still sees its
 * data. A second run is a no-op (the marker), and a value already in the new
 * place is never overwritten.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KvValue } from '@aura/kv-store';

/** The preferences that are per user. Everything else in `os` stays OS-wide. */
export const USER_PREF_KEYS = Object.freeze(['theme', 'locale', 'keymap', 'workspaces', 'app-mru', 'session'] as const);
export type UserPrefKey = (typeof USER_PREF_KEYS)[number];
export const isUserPrefKey = (key: string): key is UserPrefKey => (USER_PREF_KEYS as readonly string[]).includes(key);

/** The KV calls these helpers need (`KvClient` has them). Structural, so tests can fake it. */
export interface UserDataKv {
  get<T = unknown>(ns: string, key: string): Promise<KvValue<T> | null>;
  set<T = unknown>(ns: string, key: string, value: T): Promise<KvValue<T>>;
  del(ns: string, key: string): Promise<boolean>;
  exists(ns: string, key: string): Promise<boolean>;
  /** Raw `<namespace>:<key>` keys matching a glob. */
  scan(match: string, opts?: { limit?: number }): Promise<string[]>;
}

export const userPrefsNamespace = (userId: string): `user/${string}` => `user/${userId}/prefs`;
const userMigrationsNamespace = (userId: string): `user/${string}` => `user/${userId}/migrations`;

export type AppStorageArea = { userId: string } | 'shared';
export const appStorageNamespace = (appId: string, area: AppStorageArea): `app/${string}` =>
  area === 'shared' ? `app/${appId}/shared` : `app/${appId}/u/${area.userId}`;
/** Where an app's data lived before D46. Read as the fallback for one release. */
export const legacyAppNamespace = (appId: string): `app/${string}` => `app/${appId}`;

/** A user's preference: their own value, else the shared `os` one from before the move. */
export async function readUserPref<T = unknown>(kv: Pick<UserDataKv, 'get'>, userId: string, key: UserPrefKey): Promise<KvValue<T> | null> {
  return (await kv.get<T>(userPrefsNamespace(userId), key)) ?? kv.get<T>('os', key);
}

export async function readUserPrefValue<T = unknown>(kv: Pick<UserDataKv, 'get'>, userId: string, key: UserPrefKey): Promise<T | null> {
  return (await readUserPref<T>(kv, userId, key))?.value ?? null;
}

/** Writes only the user's own value; the old `os` value is kept for the fallback. */
export function writeUserPref<T = unknown>(kv: Pick<UserDataKv, 'set'>, userId: string, key: UserPrefKey, value: T): Promise<KvValue<T>> {
  return kv.set(userPrefsNamespace(userId), key, value);
}

/** An app's value for this user (or the shared area), falling back to its pre-D46 bucket for a user. */
export async function readAppStorage<T = unknown>(
  kv: Pick<UserDataKv, 'get'>, appId: string, area: AppStorageArea, key: string,
): Promise<KvValue<T> | null> {
  const own = await kv.get<T>(appStorageNamespace(appId, area), key);
  if (own || area === 'shared') return own;
  return kv.get<T>(legacyAppNamespace(appId), key);
}

// ── the one-time migration ──────────────────────────────────────────────────

export const USER_DATA_MIGRATION = 'user-data-v1';

export interface UserDataMigrationResult {
  ran: boolean;
  /** Absent when nothing needed a backup. */
  backup?: string;
  prefs: number;
  appKeys: number;
}

const LEGACY_APP_KEY = /^app\/([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+):(.+)$/;

/**
 * Copies today's `os` preferences and `app/<appId>` data into `ownerId`'s
 * area, once. Writes a backup of every value it reads first (JSON, 0600,
 * under `<dataDir>/aura/backups/`); without a backup nothing is copied and
 * the marker stays unset, so the next boot tries again. Never deletes or
 * changes an old value.
 */
export async function migrateUserData(
  kv: UserDataKv,
  opts: { ownerId: string; dataDir: string; now?: () => number },
): Promise<UserDataMigrationResult> {
  const now = opts.now ?? Date.now;
  const marker = userMigrationsNamespace(opts.ownerId);
  if (await kv.exists(marker, USER_DATA_MIGRATION)) return { ran: false, prefs: 0, appKeys: 0 };

  const prefs: Array<[UserPrefKey, KvValue]> = [];
  for (const key of USER_PREF_KEYS) {
    const entry = await kv.get('os', key);
    if (entry) prefs.push([key, entry]);
  }
  const apps: Array<{ appId: string; key: string; entry: KvValue }> = [];
  for (const raw of await kv.scan('app/*')) {
    const m = LEGACY_APP_KEY.exec(raw);
    if (!m) continue; // the per-user and shared areas have a longer namespace
    const entry = await kv.get(legacyAppNamespace(m[1]!), m[2]!);
    if (entry) apps.push({ appId: m[1]!, key: m[2]!, entry });
  }

  let backup: string | undefined;
  if (prefs.length || apps.length) {
    const dir = join(opts.dataDir, 'aura', 'backups');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    backup = join(dir, `${USER_DATA_MIGRATION}-${now()}.json`);
    const snapshot = {
      migration: USER_DATA_MIGRATION, at: now(), ownerId: opts.ownerId,
      os: Object.fromEntries(prefs),
      app: Object.fromEntries(apps.map((a) => [`${legacyAppNamespace(a.appId)}:${a.key}`, a.entry])),
    };
    writeFileSync(backup, JSON.stringify(snapshot), { mode: 0o600 });
    chmodSync(backup, 0o600);
  }

  let copiedPrefs = 0;
  for (const [key, entry] of prefs) {
    const ns = userPrefsNamespace(opts.ownerId);
    if (await kv.exists(ns, key)) continue;
    await kv.set(ns, key, entry.value);
    copiedPrefs++;
  }
  let copiedApp = 0;
  for (const { appId, key, entry } of apps) {
    const ns = appStorageNamespace(appId, { userId: opts.ownerId });
    if (await kv.exists(ns, key)) continue;
    await kv.set(ns, key, entry.value);
    copiedApp++;
  }
  await kv.set(marker, USER_DATA_MIGRATION, { at: now(), ...(backup ? { backup } : {}), prefs: copiedPrefs, appKeys: copiedApp });
  return { ran: true, ...(backup ? { backup } : {}), prefs: copiedPrefs, appKeys: copiedApp };
}
