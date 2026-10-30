import type { APIRoute } from 'astro';
import {
  loadSourcesConfig, saveSourcesConfig, isSourceEntry, refreshNexusSources,
  loadGitIndexDoc,
  type SourcesConfig, type SourceEntry,
} from '@aura/core';
// Namespace import for the private-source helpers: the running shell may cache
// a core build without them.
import * as core from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';
import { credentialsLoaded, loginFromBody, probeError, probeOciSource } from '../../../lib/nexusSourceLogin.js';
import { probeGitApp } from '../../../lib/nexusGitApp.js';
import { managedMarker } from '../../../lib/nexusSeeds.js';

/**
 * Nexus sources config — the catalogs/registries the store aggregates and
 * that `aura nexus app publish` can target.
 *
 *   GET  /api/nexus/sources   → current config (KV-backed, migrated from the
 *                               legacy registries key on first read)
 *   PUT  /api/nexus/sources   → replace the whole config
 *   POST /api/nexus/sources   → add one source, validated by kind
 *
 * Per-source PATCH / DELETE live in ./sources/[name].ts; pre-registered
 * sources (seed files + AURA_NEXUS_SOURCES) in ./sources/seeds.ts. A source a
 * seed marks `managed` is locked: PUT must keep it exactly as it is.
 *
 * POST content validation is STRICT per kind (the whole point of the source
 * model — the store never guesses what a git URL is):
 *   • git-index → must fetch + parse an index.yaml, else 422
 *   • git-app   → must shallow-clone + carry a valid app.manifest.json at root;
 *                 the manifest snapshot is captured into `appMeta`, else 422
 *   • oci       → listed once with `oras repo ls`. A registry that wants a
 *                 login → 422 login-required; with `username` + `password`
 *                 in the body (private store) the login must work → else 422
 *                 login-failed / unreachable. The password is sealed as an
 *                 OS-only Aura Context secret bound to the registry host
 *                 (core RegistryAuth) — the entry keeps only
 *                 `auth: {type, username, secret}`. Without a login an
 *                 unreachable registry is still accepted (it may be offline).
 *
 * The password is never stored in the config and never returned.
 */

const OS_API_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';
const DATA_DIR    = process.env['AURA_DATA_DIR'] ?? '/data';

export const GET: APIRoute = async () => {
  const cfg = await loadSourcesConfig(OS_API_BASE);
  return jsonResponse(cfg);
};

export const PUT: APIRoute = async ({ request }) => {
  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  const cfg = body as SourcesConfig;
  if (!cfg || !Array.isArray(cfg.sources) || !cfg.sources.every(isSourceEntry)) {
    return jsonResponse({ error: 'invalid-config' }, 400);
  }
  const names = new Set<string>();
  for (const s of cfg.sources) {
    if (names.has(s.name)) return jsonResponse({ error: 'duplicate-name', detail: s.name }, 400);
    names.add(s.name);
  }
  const normalised: SourcesConfig = { schema: 1, sources: cfg.sources };
  const before = await loadSourcesConfig(OS_API_BASE);
  for (const s of before.sources) {
    const m = managedMarker(s);
    if (!m) continue;
    const after = normalised.sources.find((x) => x.name === s.name);
    if (!after || JSON.stringify(after) !== JSON.stringify(s)) {
      return jsonResponse({ error: 'managed-source', detail: `${s.name} is managed by ${m.origin} and cannot be changed here` }, 409);
    }
  }
  await saveSourcesConfig(OS_API_BASE, normalised);
  refreshNexusSources(normalised);
  // Logins of sources that are gone (or no longer reference them) go too.
  const kept = new Set(normalised.sources.flatMap((s) => (s.kind === 'oci' && s.auth ? [s.auth.secret] : [])));
  for (const s of before.sources) {
    if (s.kind === 'oci' && s.auth && !kept.has(s.auth.secret)) await core.deleteRegistryLogin(DATA_DIR, s.auth);
  }
  await credentialsLoaded();
  return jsonResponse({ ok: true, config: normalised });
};

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  // A login travels beside the entry, never inside it.
  const raw = (body && typeof body === 'object' ? { ...(body as Record<string, unknown>) } : {}) as Record<string, unknown>;
  const login = loginFromBody(raw);
  if (login instanceof Response) return login;
  delete raw['username']; delete raw['password']; delete raw['auth'];
  delete raw['seed']; // only seeds mark a source (lib/nexusSeeds.ts)
  if (!isSourceEntry(raw)) {
    return jsonResponse({ error: 'invalid-entry', detail: 'expected { kind, name, url, priority }' }, 400);
  }
  const entry = raw as unknown as SourceEntry;
  if (login && entry.kind !== 'oci') {
    return jsonResponse({ error: 'invalid-login', detail: 'a username and password are only supported for oci registries' }, 400);
  }

  const cfg = await loadSourcesConfig(OS_API_BASE);
  if (cfg.sources.some((s) => s.name === entry.name)) {
    return jsonResponse({ error: 'duplicate-name', detail: entry.name }, 409);
  }

  // Strict per-kind content validation.
  try {
    if (entry.kind === 'git-index') {
      const doc = await loadGitIndexDoc(entry);
      // A valid index is parseable; empty apps is allowed (author may be
      // seeding). Reject only unparseable/unreachable (loadGitIndexDoc throws).
      void doc;
    } else if (entry.kind === 'git-app') {
      entry.appMeta = probeGitApp(entry.url, entry.ref);
    }
  } catch (err) {
    return jsonResponse({ error: 'source-validation-failed', kind: entry.kind, detail: (err as Error).message }, 422);
  }

  let apps: number | undefined;
  if (entry.kind === 'oci') {
    const probe = probeOciSource(entry.url, login, entry.appRepoPrefix);
    if (probe.ok) apps = probe.apps;
    else if (login || probe.error === 'login-required') return probeError(probe);
    // No login and merely unreachable: accepted (it may be offline right now).
    if (login) entry.auth = await core.saveRegistryLogin(DATA_DIR, entry.name, entry.url, login);
  }

  cfg.sources.push(entry);
  await saveSourcesConfig(OS_API_BASE, cfg);
  refreshNexusSources(cfg);
  await credentialsLoaded();
  return jsonResponse({ ok: true, config: cfg, ...(apps !== undefined ? { apps } : {}) });
};
