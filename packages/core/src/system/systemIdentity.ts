/**
 * The identity of this Aura (D47): a permanent random `systemId` and an
 * Ed25519 system key pair, created on first boot.
 *
 *   <dataDir>/aura/system.json          { v, systemId, publicKey, createdAt }
 *   <dataDir>/aura/secrets/system.key   the private key (PKCS#8 PEM, 0600),
 *                                       next to identity.key, master-only
 *
 * The id never changes across updates, restores and Developer Mode. A copied
 * `/data` (a test VM, a clone) must not share it: the host command
 * `aura system reidentify` gives the copy a new id and key. Pairing and
 * signing come with federation; the key exists now so the identity is
 * complete from the first boot.
 *
 * Cross-system references are qualified as `<localId>@<systemId>`
 * (`qualifiedRef`); local storage keeps the local id.
 *
 * File-only (no Valkey, no server runtime): the CLI imports it through
 * `@aura/core/system-identity`.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { ensurePrivateDir } from './privateDir.js';
import { dirname, join } from 'node:path';

export interface SystemIdentity {
  systemId: string;
  /** SPKI PEM of the system key. */
  publicKey: string;
  createdAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const defaultDataDir = (): string => process.env['AURA_DATA_DIR'] ?? '/data';
export const systemIdentityFile = (dataDir: string = defaultDataDir()): string => join(dataDir, 'aura', 'system.json');
export const systemKeyFile = (dataDir: string = defaultDataDir()): string => join(dataDir, 'aura', 'secrets', 'system.key');

/** Write via a temp file and rename, so a crash never leaves half a file. */
function writeAtomic(file: string, content: string, mode: number): void {
  if (file.includes('/secrets/')) ensurePrivateDir(dirname(file));
  else mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

function readIdentity(dataDir: string): SystemIdentity | null {
  try {
    const o = JSON.parse(readFileSync(systemIdentityFile(dataDir), 'utf-8')) as Partial<SystemIdentity> & { v?: unknown };
    if (o.v !== 1 || typeof o.systemId !== 'string' || !UUID.test(o.systemId) || typeof o.publicKey !== 'string') return null;
    return { systemId: o.systemId, publicKey: o.publicKey, createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0 };
  } catch {
    return null;
  }
}

/** A new key pair: the private key goes to the secrets dir, the public one is returned. */
function newKeyPair(dataDir: string): string {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeAtomic(systemKeyFile(dataDir), privateKey, 0o600);
  return publicKey;
}

function create(dataDir: string, systemId: string, now: number): SystemIdentity {
  const identity: SystemIdentity = { systemId, publicKey: newKeyPair(dataDir), createdAt: now };
  writeAtomic(systemIdentityFile(dataDir), `${JSON.stringify({ v: 1, ...identity }, null, 2)}\n`, 0o644);
  return identity;
}

/**
 * This system's identity, created on first use. An unreadable or invalid
 * `system.json` is never overwritten silently: it throws, and the operator
 * decides (move it aside, or `aura system reidentify`). A missing private
 * key with a valid id gets a new key pair under the same id.
 */
export function ensureSystemIdentity(dataDir: string = defaultDataDir(), now: () => number = Date.now): SystemIdentity {
  const file = systemIdentityFile(dataDir);
  if (!existsSync(file)) return create(dataDir, randomUUID(), now());
  const found = readIdentity(dataDir);
  if (!found) throw new Error(`${file} is not a valid system identity: move it aside or run \`aura system reidentify\` on the host`);
  if (!existsSync(systemKeyFile(dataDir))) return create(dataDir, found.systemId, found.createdAt || now());
  return found;
}

/**
 * A new `systemId` and key pair for a copied `/data`. The old id is returned
 * so the caller can report it. Run it with the shell stopped: a running shell
 * keeps the id it read at start.
 */
export function reidentifySystem(
  dataDir: string = defaultDataDir(), now: () => number = Date.now,
): { previous: string | null; current: SystemIdentity } {
  const previous = readIdentity(dataDir)?.systemId ?? null;
  let next = randomUUID();
  while (next === previous) next = randomUUID();
  const current = create(dataDir, next, now());
  resetSystemIdCache();
  return { previous, current };
}

const CACHE = Symbol.for('aura.system.id');
type Cached = { dataDir: string; systemId: string };

/**
 * The local `systemId`, read once per process (created on first boot). Every
 * code path that names a principal, a claim, an audit entry or an interface
 * reads this instead of assuming "local", so a remote system later is a new
 * value, not a new code path.
 */
export function localSystemId(dataDir: string = defaultDataDir()): string {
  const g = globalThis as { [CACHE]?: Cached };
  const hit = g[CACHE];
  if (hit && hit.dataDir === dataDir) return hit.systemId;
  const systemId = ensureSystemIdentity(dataDir).systemId;
  g[CACHE] = { dataDir, systemId };
  return systemId;
}

export function resetSystemIdCache(): void {
  delete (globalThis as { [CACHE]?: Cached })[CACHE];
}

/** `<localId>@<systemId>`: how a user, instance or installation is named across systems. */
export function qualifiedRef(localId: string, systemId: string = localSystemId()): string {
  return `${localId}@${systemId}`;
}
