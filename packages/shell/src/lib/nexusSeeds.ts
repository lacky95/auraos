/**
 * Pre-registered Nexus sources ("seeds") — pure parsing + merge rules.
 * The I/O (reading files, KV, sealing logins) is in nexusSeedsApply.ts.
 *
 * An install ships sources the store and `aura nexus app publish --to <alias>`
 * know from the first boot. Seeds are read from, in rising precedence:
 *   1. /etc/aura/nexus/sources.d/*.json   — shipped with the install (read-only)
 *   2. <dataDir>/nexus/sources.d/*.json   — admin-editable, persistent
 *   3. AURA_NEXUS_SOURCES                 — JSON, or a path to a JSON file
 * Files apply in name order; the same alias later wins.
 *
 * A file / the env var holds `[ …entries ]` or `{ "sources": [ …entries ] }`:
 *   { "name": "acme",                  // the alias (`--to acme`)
 *     "kind": "oci",                   // oci (default) | git-index | git-app
 *     "url":  "https://registry.acme.com",
 *     "priority": 10,                  // lower = checked first (default 10)
 *     "mirror": false, "appRepoPrefix": "aura-apps",   // oci
 *     "ref": "main", "repo": "acme/store",             // git-*
 *     "policy": "seed",                // seed (default) | managed
 *     "username": "ci",                // optional login (oci only), with ONE of
 *     "password": "…" | "passwordEnv": "ACME_PW" | "passwordFile": "/run/secrets/acme" }
 *
 * Policies:
 *   • seed    — added once. The user owns it afterwards: edits and removal
 *               stick. Only a CHANGE of that entry in the seed re-applies it.
 *   • managed — enforced on every boot and on re-apply; locked in Nexus (no
 *               edit/remove). Removing it from the seeds removes the source.
 * A seeded login is sealed into the OS-only secret store like any other
 * login; the source entry keeps only the reference.
 */
import type { SourceAuth, SourceEntry, SourcesConfig } from '@aura/core';

export type SeedPolicy = 'seed' | 'managed';

/** Marker on a source that came from a seed (shown in Nexus). */
export interface SeedMarker { policy: SeedPolicy; origin: string }

export interface SeedLogin { username: string; password: string }

export interface SeedEntry {
  /** The source as the seed declares it (no auth). */
  entry:  SourceEntry;
  policy: SeedPolicy;
  /** File path or 'env:AURA_NEXUS_SOURCES'. */
  origin: string;
  login?: SeedLogin;
  /** Fingerprint of entry + policy + login: a change re-applies a `seed`. */
  hash:   string;
}

/** What was applied per alias (KV os/nexus/source-seeds). */
export type SeedState = Record<string, { hash: string; policy: SeedPolicy }>;

export interface SeedProblem { origin: string; detail: string }

/** Optional resolvers so parsing stays pure and testable. */
export interface SeedEnv {
  env:      Record<string, string | undefined>;
  readFile: (path: string) => string;
  hash:     (s: string) => string;
}

const KINDS = new Set(['oci', 'git-index', 'git-app']);

/** Parse one seed document (file or env value). */
export function parseSeedDoc(text: string, origin: string, io: SeedEnv): { seeds: SeedEntry[]; problems: SeedProblem[] } {
  const seeds: SeedEntry[] = [];
  const problems: SeedProblem[] = [];
  let doc: unknown;
  try { doc = JSON.parse(text); }
  catch (err) { return { seeds, problems: [{ origin, detail: `invalid JSON: ${(err as Error).message}` }] }; }
  const list = Array.isArray(doc) ? doc
    : doc && typeof doc === 'object' && Array.isArray((doc as { sources?: unknown }).sources) ? (doc as { sources: unknown[] }).sources
    : null;
  if (!list) return { seeds, problems: [{ origin, detail: 'expected an array of sources or { "sources": [...] }' }] };

  list.forEach((raw, i) => {
    const where = `${origin}#${i}`;
    if (!raw || typeof raw !== 'object') { problems.push({ origin: where, detail: 'entry is not an object' }); return; }
    const r = raw as Record<string, unknown>;
    const name = typeof r['name'] === 'string' ? r['name'].trim() : '';
    const kind = r['kind'] === undefined ? 'oci' : r['kind'];
    const url = typeof r['url'] === 'string' ? r['url'].trim() : '';
    if (!name) { problems.push({ origin: where, detail: 'missing "name" (the alias)' }); return; }
    if (typeof kind !== 'string' || !KINDS.has(kind)) { problems.push({ origin: where, detail: `${name}: kind must be oci | git-index | git-app` }); return; }
    if (!url) { problems.push({ origin: where, detail: `${name}: missing "url"` }); return; }
    const policy = r['policy'] === undefined ? 'seed' : r['policy'];
    if (policy !== 'seed' && policy !== 'managed') { problems.push({ origin: where, detail: `${name}: policy must be seed | managed` }); return; }
    const priority = typeof r['priority'] === 'number' && Number.isFinite(r['priority']) ? r['priority'] : 10;

    const entry: Record<string, unknown> = { kind, name, url, priority };
    if (kind === 'oci') {
      if (typeof r['mirror'] === 'boolean') entry['mirror'] = r['mirror'];
      if (typeof r['appRepoPrefix'] === 'string' && r['appRepoPrefix']) entry['appRepoPrefix'] = r['appRepoPrefix'];
    } else {
      if (typeof r['ref'] === 'string' && r['ref']) entry['ref'] = r['ref'];
      if (kind === 'git-index' && typeof r['repo'] === 'string' && r['repo']) entry['repo'] = r['repo'];
    }

    let login: SeedLogin | undefined;
    const username = typeof r['username'] === 'string' ? r['username'].trim() : '';
    const hasPw = r['password'] !== undefined || r['passwordEnv'] !== undefined || r['passwordFile'] !== undefined;
    if (username || hasPw) {
      if (kind !== 'oci') { problems.push({ origin: where, detail: `${name}: a login is only supported for oci sources` }); return; }
      let password: string | undefined;
      try {
        if (typeof r['password'] === 'string') password = r['password'];
        else if (typeof r['passwordEnv'] === 'string') password = io.env[r['passwordEnv']];
        else if (typeof r['passwordFile'] === 'string') password = io.readFile(r['passwordFile']).replace(/\r?\n$/, '');
      } catch (err) {
        problems.push({ origin: where, detail: `${name}: cannot read password: ${(err as Error).message}` }); return;
      }
      if (!username || !password) { problems.push({ origin: where, detail: `${name}: a login needs "username" and a password (password | passwordEnv | passwordFile)` }); return; }
      login = { username, password };
    }

    const hash = io.hash(JSON.stringify({ entry, policy, login: login ? [login.username, io.hash(login.password)] : null }));
    seeds.push({ entry: entry as unknown as SourceEntry, policy, origin, login, hash });
  });
  return { seeds, problems };
}

/** Later seeds win per alias (callers pass them in precedence order). */
export function dedupeSeeds(seeds: SeedEntry[]): SeedEntry[] {
  const byName = new Map<string, SeedEntry>();
  for (const s of seeds) { byName.delete(s.entry.name); byName.set(s.entry.name, s); }
  return [...byName.values()];
}

export interface MergeResult {
  config:  SourcesConfig;
  state:   SeedState;
  /** Logins to seal; the caller sets `auth` on the named entry. */
  logins:  Array<{ name: string; url: string; login: SeedLogin }>;
  /** Sealed logins that are no longer referenced (source removed). */
  dropAuth: SourceAuth[];
  /** Git-app entries whose manifest snapshot must be (re)probed. */
  probe:   string[];
  changes: string[];
}

type Marked = SourceEntry & { seed?: SeedMarker };

/**
 * Apply seeds to a sources config. Pure: returns the new config and state,
 * plus the side work (logins to seal, git-apps to probe) for the caller.
 */
export function mergeSeeds(cfg: SourcesConfig, seeds: SeedEntry[], state: SeedState): MergeResult {
  const sources: Marked[] = cfg.sources.map((s) => ({ ...s }));
  const next: SeedState = { ...state };
  const out: MergeResult = { config: cfg, state: next, logins: [], dropAuth: [], probe: [], changes: [] };
  const seeded = new Set(seeds.map((s) => s.entry.name));

  for (const s of seeds) {
    const name = s.entry.name;
    const idx = sources.findIndex((x) => x.name === name);
    const existing = idx >= 0 ? sources[idx]! : null;
    const prev = state[name];
    const marker: SeedMarker = { policy: s.policy, origin: s.origin };
    const fresh = !prev || prev.hash !== s.hash;

    if (s.policy === 'seed' && !fresh) {
      // Applied before and unchanged: the user owns it now. Only keep the
      // marker in step (it may have been removed — that removal sticks).
      if (existing) existing.seed = marker;
      next[name] = { hash: s.hash, policy: s.policy };
      continue;
    }

    const target: Marked = { ...(s.entry as Marked), seed: marker };
    // Keep what the seed doesn't own: a sealed login (unless the seed brings
    // one) and a git-app's manifest snapshot (unless the repo changed).
    const ex = existing as (Marked & { auth?: SourceAuth; appMeta?: unknown; url?: string; ref?: string }) | null;
    if (ex?.auth && !s.login) (target as { auth?: SourceAuth }).auth = ex.auth;
    if (target.kind === 'git-app') {
      const sameRepo = ex?.kind === 'git-app' && ex.url === target.url && ex.ref === (target as { ref?: string }).ref;
      if (sameRepo && ex?.appMeta) (target as { appMeta?: unknown }).appMeta = ex.appMeta;
      else out.probe.push(name);
    }
    if (s.login && (fresh || !ex?.auth)) out.logins.push({ name, url: target.url, login: s.login });
    else if (s.login && ex?.auth) (target as { auth?: SourceAuth }).auth = ex.auth;

    const changed = !existing || JSON.stringify(existing) !== JSON.stringify(target);
    if (idx >= 0) sources[idx] = target; else sources.push(target);
    if (changed) out.changes.push(`${existing ? 'updated' : 'added'} ${name} (${s.policy}, ${s.origin})`);
    next[name] = { hash: s.hash, policy: s.policy };
  }

  // Seeds that disappeared.
  for (const [name, st] of Object.entries(state)) {
    if (seeded.has(name)) continue;
    delete next[name];
    const idx = sources.findIndex((x) => x.name === name);
    if (idx < 0) continue;
    const src = sources[idx]!;
    if (st.policy === 'managed' && src.seed?.policy === 'managed') {
      // The file owned it — it goes with the file. Never the last registry.
      const ociLeft = sources.filter((x) => x.kind === 'oci' && x !== src).length;
      if (src.kind === 'oci' && ociLeft === 0) { delete src.seed; continue; }
      const auth = (src as { auth?: SourceAuth }).auth;
      if (auth) out.dropAuth.push(auth);
      sources.splice(idx, 1);
      out.changes.push(`removed ${name} (managed seed gone)`);
    } else if (src.seed) {
      delete src.seed; // now an ordinary, user-owned source
    }
  }

  out.config = { schema: 1, sources };
  return out;
}

/** The managed marker of a source, if any (API guards + UI lock). */
export function managedMarker(s: unknown): SeedMarker | null {
  const m = (s as { seed?: SeedMarker } | null)?.seed;
  return m && m.policy === 'managed' ? m : null;
}
