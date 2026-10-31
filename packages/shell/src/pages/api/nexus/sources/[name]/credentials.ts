import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { jsonResponse } from '../../../../../lib/appResponse.js';
import { credentialsLoaded, loginFromBody, probeError, probeOciSource } from '../../../../../lib/nexusSourceLogin.js';
import { managedMarker } from '../../../../../lib/nexusSeeds.js';

/**
 * The login of a private OCI source (Nexus → Sources "Edit login",
 * `aura nexus registry login <name>`).
 *
 *   PUT    {username, password} → checked against the registry, then sealed
 *                                 (OS-only, bound to the registry host);
 *                                 422 login-failed / unreachable
 *   DELETE                      → forget the login; the source stays
 *
 * The password is never stored in the sources config and never returned.
 */
const OS_API_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';
const DATA_DIR    = process.env['AURA_DATA_DIR'] ?? '/data';

async function ociSourceOr404(name: string | undefined) {
  const cfg = await core.loadSourcesConfig(OS_API_BASE);
  const src = cfg.sources.find((s) => s.name === name);
  if (!src) return { cfg, res: jsonResponse({ error: 'not-found', detail: name }, 404) };
  if (src.kind !== 'oci') return { cfg, res: jsonResponse({ error: 'not-oci', detail: 'only oci registries take a login' }, 400) };
  const managed = managedMarker(src);
  if (managed) return { cfg, res: jsonResponse({ error: 'managed-source', detail: `${src.name} is managed by ${managed.origin} — change its login there` }, 409) };
  return { cfg, src };
}

export const PUT: APIRoute = async ({ params, request }) => {
  const { cfg, src, res } = await ociSourceOr404(params['name']);
  if (res) return res;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  const login = loginFromBody(body ?? {});
  if (login instanceof Response) return login;
  if (!login) return jsonResponse({ error: 'invalid-login', detail: 'send a username and password' }, 400);

  const probe = await probeOciSource(src!.url, login, src!.appRepoPrefix);
  if (!probe.ok) return probeError(probe);
  src!.auth = await core.saveRegistryLogin(DATA_DIR, src!.name, src!.url, login);
  await core.saveSourcesConfig(OS_API_BASE, cfg);
  core.refreshNexusSources(cfg);
  await credentialsLoaded();
  return jsonResponse({ ok: true, source: src, apps: probe.apps });
};

export const DELETE: APIRoute = async ({ params }) => {
  const { cfg, src, res } = await ociSourceOr404(params['name']);
  if (res) return res;
  if (src!.auth) {
    await core.deleteRegistryLogin(DATA_DIR, src!.auth);
    delete src!.auth;
    await core.saveSourcesConfig(OS_API_BASE, cfg);
    core.refreshNexusSources(cfg);
    await credentialsLoaded();
  }
  return jsonResponse({ ok: true, source: src });
};
