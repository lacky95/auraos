/**
 * Infrastructure credentials in the kernel (D94 §4.3, IC-5): the first-boot import of the
 * install-time `bootstrap:<name>` refs into the System Context, and the per-operation resolver.
 *
 *   import     install.sh (`installer.mjs write-data --credentials-dir`) leaves the bootstrap
 *              files in `/data/aura/infra/import/` (0600, dir 0700). The first boot seals each
 *              into `context:system:INFRA_<NAME>` (`kind: secret`, `inject: []`: no app, no file),
 *              as `{v:1, hosts, kind, …}` bound to the hosts the config uses it for, rewrites the
 *              config's ref to `system:INFRA_<NAME>` and deletes the file.
 *   resolve    `credentialResolver()` reads the refs one operation needs into memory, checks the
 *              host binding (a ref pointed at another host by a config change is refused, D94
 *              §7.4), and returns a sync resolver for the os/infra adapters.
 * Values never reach a log, an env of a long-lived process, argv or an error message.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ContextStore } from '../context/ContextStore.js';
import { loadOsInfra } from './osInfra.js';
import { INFRA_DIR } from './types.js';

/** A credential as a client submits it (validated by setInfraCredential). */
export type InfraCredentialInput = InfraCredential;

export type InfraCredential =
  | { kind: 'basic'; user: string; password: string }
  | { kind: 'private-key'; pem: string };

interface SealedInfraCredential { v: 1; hosts: string[]; cred: InfraCredential }

export const INFRA_IMPORT_DIR = `${INFRA_DIR}/import`;

/** The System Context key of an imported bootstrap credential. */
export function systemKeyFor(name: string): string {
  return `INFRA_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

const systemKeyOf = (ref: string): string | null => (/^system:/.test(ref) ? ref.slice('system:'.length) : null);
const bootstrapNameOf = (ref: string): string | null => (/^bootstrap:/.test(ref) ? ref.slice('bootstrap:'.length) : null);

export class InfraCredentialBindingError extends Error {
  readonly code = 'infra-credential-binding';
  constructor(message: string) { super(message); this.name = 'InfraCredentialBindingError'; }
}

/**
 * A sync resolver for the refs of one operation. `system:` refs come from the sealed System
 * Context (host-bound); `bootstrap:` refs not imported yet from the import dir. An unknown ref
 * resolves to null (the caller refuses).
 */
export async function credentialResolver(o: {
  dataDir: string;
  refs: Array<{ ref: string; path: string; hosts: string[] }>;
  context?: Pick<ContextStore, 'get'>;
}): Promise<(ref: string) => InfraCredential | null> {
  const found = new Map<string, InfraCredential>();
  const osi = await loadOsInfra();
  const importDir = join(o.dataDir, INFRA_IMPORT_DIR);
  let context = o.context ?? null;
  for (const r of o.refs) {
    if (found.has(r.ref)) continue;
    const key = systemKeyOf(r.ref);
    if (key) {
      context ??= new ContextStore(o.dataDir);
      const raw = await context.get(key).catch(() => null);
      if (!raw) continue;
      let sealed: SealedInfraCredential;
      try { sealed = JSON.parse(raw) as SealedInfraCredential; } catch { continue; }
      if (sealed?.v !== 1 || !Array.isArray(sealed.hosts) || !sealed.cred) continue;
      const stray = r.hosts.filter((h) => !sealed.hosts.includes(h));
      if (stray.length) {
        throw new InfraCredentialBindingError(`${r.ref} (${r.path}) is bound to other hosts than ${stray.join(', ')}: re-import it for the new hosts (aura admin infra credential set)`);
      }
      found.set(r.ref, sealed.cred);
      continue;
    }
    const name = bootstrapNameOf(r.ref);
    if (name && existsSync(join(importDir, name))) {
      found.set(r.ref, osi.secrets.readBootstrapCredential(importDir, name, { uid: 0 }) as InfraCredential);
    }
  }
  return (ref) => found.get(ref) ?? null;
}

export interface ImportResult { imported: string[]; rewritten: boolean; bootstrapRefsLeft: number }

/**
 * First boot (and any boot that finds new import files): seal every imported bootstrap
 * credential the config references, rewrite those refs to `system:`, delete the files. A file
 * the config does not reference is deleted too (it was staged for nothing). Idempotent.
 */
export async function importBootstrapCredentials(o: {
  dataDir: string;
  context?: Pick<ContextStore, 'set'>;
}): Promise<ImportResult> {
  const importDir = join(o.dataDir, INFRA_IMPORT_DIR);
  const osi = await loadOsInfra();
  const dir = osi.store.infraDir(o.dataDir);
  const left = (): number => {
    const st = osi.store.readStore(dir);
    return st ? (osi.config.refsOf(st.config) as Array<{ ref: string }>).filter((r) => bootstrapNameOf(r.ref)).length : 0;
  };
  const files = existsSync(importDir) ? readdirSync(importDir).filter((f) => !f.startsWith('.')) : [];
  if (!files.length) {
    rmSync(importDir, { recursive: true, force: true });
    return { imported: [], rewritten: false, bootstrapRefsLeft: left() };
  }
  const store = osi.store.readStore(dir);
  const context = o.context ?? new ContextStore(o.dataDir);
  const imported: string[] = [];
  let rewritten = false;
  if (store) {
    const byName = new Map<string, string[]>();
    for (const r of osi.config.refsOf(store.config) as Array<{ ref: string; hosts: string[] }>) {
      const n = bootstrapNameOf(r.ref);
      if (n) byName.set(n, [...new Set([...(byName.get(n) ?? []), ...r.hosts])].sort());
    }
    const renamed = new Map<string, string>();
    for (const [name, hosts] of byName) {
      if (!files.includes(name)) continue;
      const cred = osi.secrets.readBootstrapCredential(importDir, name, { uid: 0 }) as InfraCredential;
      const key = systemKeyFor(name);
      const sealed: SealedInfraCredential = { v: 1, hosts, cred };
      await context.set(key, JSON.stringify(sealed), 'secret', []);
      imported.push(name);
      renamed.set(`bootstrap:${name}`, `system:${key}`);
    }
    if (renamed.size) {
      const cfg = rewriteRefs(structuredClone(store.config), renamed);
      osi.store.writeStore(dir, { text: osi.store.STORE_HEADER + osi.config.toYaml(cfg), files: store.files, digest: store.digest });
      rewritten = true;
    }
  }
  rmSync(importDir, { recursive: true, force: true });
  return { imported, rewritten, bootstrapRefsLeft: left() };
}

/** Every `{ ref }` whose value is in `renamed`, replaced (in place). */
function rewriteRefs<T>(v: T, renamed: Map<string, string>): T {
  if (Array.isArray(v)) { v.forEach((x) => rewriteRefs(x, renamed)); return v; }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const [k, x] of Object.entries(o)) {
      if (k === 'ref' && typeof x === 'string' && renamed.has(x)) o[k] = renamed.get(x);
      else rewriteRefs(x, renamed);
    }
  }
  return v;
}
