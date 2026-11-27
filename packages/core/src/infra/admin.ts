/**
 * The infrastructure configuration's management (D94 IC-1, §4.1, §4.5): show, validate, diff,
 * apply and the credentials, for `GET/PUT /api/admin/infra`, `POST /api/admin/infra/validate`,
 * `PUT|DELETE /api/admin/infra/credentials/<name>` and `aura admin infra …`. One implementation:
 * the schema, the store and the render are os/infra's (config.mjs, store.mjs, render.mjs); this
 * module only stages a client's text, applies it and reloads the running shell.
 *
 * A client sends the config text and the public files it names (CA and client certificates),
 * keyed by the path the config uses; nothing secret ever travels here except a credential set
 * through its own call, which is sealed at once and never returned. Answers carry field paths,
 * names and digests, never a value.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { ContextStore } from '../context/ContextStore.js';
import { loadOsInfra } from './osInfra.js';
import { dataRootOf, renderDigest } from './propagate.js';
import { credentialResolver, systemKeyFor, type InfraCredential } from './credentials.js';
import { reloadInfrastructure } from './kernel.js';

export class InfraAdminError extends Error {
  constructor(readonly code: 'invalid-config' | 'invalid-request' | 'no-such-ref' | 'policy-in-config', message: string, readonly errors: Array<{ path: string; message: string }> = []) {
    super(message);
    this.name = 'InfraAdminError';
  }
}

export interface InfraSubmission {
  /** The config (YAML or JSON) as the client has it. */
  config: string;
  /** The public files it names, by the path written in the config (relative to the config). */
  files?: Record<string, string>;
}

interface Staged { config: Record<string, unknown>; text: string; files: Record<string, string>; warnings: Array<{ path: string; message: string }>; digest: string }

const MAX_TEXT = 256 * 1024;

/** The submission through os/infra's stageConfig (validation, certificate checks, the store form). */
export async function stageSubmission(sub: InfraSubmission): Promise<Staged> {
  if (typeof sub?.config !== 'string' || !sub.config.trim() || sub.config.length > MAX_TEXT) throw new InfraAdminError('invalid-request', 'expected { config: <text>, files?: { <path>: <PEM> } }');
  const osi = await loadOsInfra();
  const dir = mkdtempSync(join(tmpdir(), 'aura-infra-stage-'));
  try {
    for (const [rel, pem] of Object.entries(sub.files ?? {})) {
      const n = normalize(rel);
      if (typeof pem !== 'string' || pem.length > MAX_TEXT || isAbsolute(n) || n.startsWith('..')) throw new InfraAdminError('invalid-request', `files["${rel}"]: a relative path and a PEM text`);
      mkdirSync(dirname(join(dir, n)), { recursive: true });
      writeFileSync(join(dir, n), pem, { mode: 0o600 });
    }
    writeFileSync(join(dir, 'config.yaml'), sub.config, { mode: 0o600 });
    try {
      const staged = osi.store.stageConfig(join(dir, 'config.yaml')) as Staged;
      if (staged.config['policy'] !== undefined) {
        throw new InfraAdminError('policy-in-config', 'policy: is the install seed only; change infra-public-fallback and infra-proxy with `aura admin security set`', [{ path: 'policy', message: 'install seed only' }]);
      }
      return staged;
    } catch (err) {
      if (err instanceof InfraAdminError) throw err;
      const errors = (err as { errors?: Array<{ path: string; message: string }> }).errors;
      if (errors) throw new InfraAdminError('invalid-config', 'the infrastructure config is invalid', errors.map((e) => ({ path: e.path, message: e.message.replace(dir, '<config dir>') })));
      throw err;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A line diff of two store texts (non-secret by construction). */
export function infraDiff(before: string, after: string): string[] {
  const a = before.split('\n'), b = after.split('\n');
  const out: string[] = [];
  // LCS on lines: configs are small.
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push(`- ${a[i++]}`); else out.push(`+ ${b[j++]}`);
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out.filter((l) => l.trim() !== '-' && l.trim() !== '+');
}

export interface InfraShow {
  configured: boolean;
  /** The stored config (non-secret: references only). */
  text: string | null;
  configDigest: string | null;
  renderDigest: string | null;
  warnings: Array<{ path: string; message: string }>;
  credentials: Array<{ ref: string; path: string; hosts: string[]; status: 'ok' | 'missing' }>;
}

export async function showInfra(o: { dataDir?: string; context?: Pick<ContextStore, 'get'> } = {}): Promise<InfraShow> {
  const dataDir = dataRootOf(o.dataDir);
  const osi = await loadOsInfra();
  const store = osi.store.readStore(osi.store.infraDir(dataDir));
  if (!store) return { configured: false, text: null, configDigest: null, renderDigest: renderDigest(dataDir), warnings: [], credentials: [] };
  const refs = osi.config.refsOf(store.config) as Array<{ ref: string; path: string; hosts: string[] }>;
  let resolve: (ref: string) => InfraCredential | null = () => null;
  try { resolve = await credentialResolver({ dataDir, refs, ...(o.context ? { context: o.context } : {}) }); } catch { /* reported as missing */ }
  return {
    configured: true, text: store.text, configDigest: store.digest, renderDigest: renderDigest(dataDir), warnings: store.warnings,
    credentials: refs.map((r) => ({ ref: r.ref, path: r.path, hosts: r.hosts, status: resolve(r.ref) ? 'ok' : 'missing' })),
  };
}

export interface InfraValidation { ok: true; configDigest: string; warnings: Array<{ path: string; message: string }>; diff: string[]; changed: boolean }

/** Validate a submission and diff it against the stored config (nothing written). */
export async function validateInfra(sub: InfraSubmission, o: { dataDir?: string } = {}): Promise<InfraValidation> {
  const osi = await loadOsInfra();
  const staged = await stageSubmission(sub);
  const cur = osi.store.readStore(osi.store.infraDir(dataRootOf(o.dataDir)));
  return { ok: true, configDigest: staged.digest, warnings: staged.warnings, diff: infraDiff(cur?.text ?? '', staged.text), changed: cur?.digest !== staged.digest };
}

export interface InfraApplyResult {
  changed: boolean;
  configDigest: string;
  renderDigest: string | null;
  /** The running shell took it live; instances get the new env at their next start. */
  restartRequired: boolean;
  issues: string[];
  diff: string[];
}

/**
 * Apply: validate, write the store atomically (`config.yaml.prev` kept), render
 * (`generated/<digest>`, atomic `current`), reload the running shell. Idempotent: the same config
 * changes nothing. The caller decided who may (the owner at fresh, or the host operator) and audits.
 */
export async function applyInfra(sub: InfraSubmission, o: { dataDir?: string } = {}): Promise<InfraApplyResult> {
  const dataDir = dataRootOf(o.dataDir);
  const osi = await loadOsInfra();
  const staged = await stageSubmission(sub);
  const dir = osi.store.infraDir(dataDir);
  const cur = osi.store.readStore(dir);
  const diff = infraDiff(cur?.text ?? '', staged.text);
  const changed = cur?.digest !== staged.digest;
  if (changed) osi.store.writeStore(dir, staged);
  const r = osi.render.applyGenerated(dir) as { digest: string | null; changed: boolean };
  const st = reloadInfrastructure();
  return { changed: changed || r.changed, configDigest: staged.digest, renderDigest: r.digest, restartRequired: st.restartRequired, issues: st.issues, diff };
}

/**
 * Set (or rotate) the credential behind `system:INFRA_<NAME>`: sealed into the System Context, bound
 * to the hosts the stored config uses that reference for. Refused when no reference uses it (a
 * credential for nothing, or a typo). The value is never returned.
 */
export async function setInfraCredential(o: {
  name: string; credential: InfraCredential; dataDir?: string; context?: Pick<ContextStore, 'set'>;
}): Promise<{ key: string; hosts: string[] }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(o.name)) throw new InfraAdminError('invalid-request', 'a credential name: letters, digits, _ . -');
  const c = o.credential;
  const ok = c && ((c.kind === 'basic' && typeof c.user === 'string' && !!c.user && !c.user.includes(':') && typeof c.password === 'string' && !!c.password)
    || (c.kind === 'private-key' && typeof c.pem === 'string' && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(c.pem)));
  if (!ok) throw new InfraAdminError('invalid-request', 'expected { kind: "basic", user, password } or { kind: "private-key", pem }');
  const dataDir = dataRootOf(o.dataDir);
  const osi = await loadOsInfra();
  const store = osi.store.readStore(osi.store.infraDir(dataDir));
  const key = systemKeyFor(o.name);
  const refs = (store ? osi.config.refsOf(store.config) as Array<{ ref: string; path: string; hosts: string[] }> : [])
    .filter((r) => r.ref === `system:${key}`);
  if (!refs.length) throw new InfraAdminError('no-such-ref', `no reference in the infrastructure config is system:${key} (a bootstrap: ref is imported at the first boot; reference system:${key} in the config first)`);
  if (refs.some((r) => r.path.startsWith('clientCertificates.')) !== (c.kind === 'private-key')) {
    throw new InfraAdminError('invalid-request', `${o.name} is used for ${refs.map((r) => r.path).join(', ')}: expected ${c.kind === 'private-key' ? 'username:password' : 'a PEM private key'}`);
  }
  const hosts = [...new Set(refs.flatMap((r) => r.hosts))].sort();
  await (o.context ?? new ContextStore(dataDir)).set(key, JSON.stringify({ v: 1, hosts, cred: c }), 'secret', []);
  return { key, hosts };
}

export async function removeInfraCredential(o: { name: string; dataDir?: string; context?: Pick<ContextStore, 'del'> }): Promise<boolean> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(o.name)) throw new InfraAdminError('invalid-request', 'a credential name: letters, digits, _ . -');
  return (o.context ?? new ContextStore(dataRootOf(o.dataDir))).del(systemKeyFor(o.name));
}
