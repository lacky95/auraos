import type { APIRoute } from 'astro';
import { getNexusManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../lib/appResponse.js';

const OS_API_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';

/**
 * Publish an app from a local path. v1: Git is the working path; OCI
 * shells out to `oras` if available, otherwise returns a clear error
 * the CLI surfaces to the user.
 *
 * Body:
 *   {
 *     path:     string,      // local app dir
 *     source?:  'git' | 'oci',  // default 'git' (alias: `kind`)
 *     kind?:    'git' | 'oci',  // alias of `source` (CLI noun-group wording)
 *     to?:      string,      // target: source name / registry URL / git repo
 *     repo?:    string,      // git target (overrides manifest.publish.repo)
 *     registry?: string,     // oci target (overrides manifest.publish.registry)
 *     tag?:     string,
 *     channel?: string,
 *     branch?:  string,
 *   }
 *
 * `to` is the noun-group convenience: for oci it maps to `registry`, for git
 * to `repo`. Explicit `registry`/`repo` win over `to`.
 */
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({})) as {
    path?:    string;
    source?:  'git' | 'oci';
    kind?:    'git' | 'oci';
    to?:      string;
    repo?:    string;
    registry?: string;
    tag?:     string;
    channel?: string;
    branch?:  string;
  };
  if (!body.path) return errorResponse('missing `path`', 400);

  const source = body.kind ?? body.source ?? 'git';
  const repoTarget     = body.repo ?? (source === 'git' ? body.to : undefined);
  const registryTarget = body.registry ?? (source === 'oci' ? body.to : undefined);
  const nexus = getNexusManager();
  await nexus.ensureSourcesLoaded(OS_API_BASE);

  try {
    if (source === 'git') {
      const it = nexus.publishGit({
        appPath: body.path,
        repo:    repoTarget,
        branch:  body.branch,
        tag:     body.tag,
        channel: body.channel,
      });
      const messages: string[] = [];
      let result: { ref: string; installCmd: string } | undefined;
      let cursor = await it.next();
      while (!cursor.done) {
        const ev = cursor.value;
        if (ev.type === 'publish.progress') messages.push(ev.message);
        if (ev.type === 'publish.done')     result = { ref: ev.ref, installCmd: '' };
        if (ev.type === 'error')            return errorResponse(ev.message, 500);
        cursor = await it.next();
      }
      // Generator returns the full PublishGitResult after the final yield.
      if (cursor.value) result = cursor.value;
      return jsonResponse({ ok: true, source: 'git', result, messages });
    }
    // OCI
    if (!registryTarget) return errorResponse('missing `registry`/`to` for OCI publish', 400);
    const it = nexus.publishOci({
      appPath:  body.path,
      registry: registryTarget,
      tag:      body.tag ?? 'latest',
      channel:  body.channel,
    });
    const messages: string[] = [];
    let result: { ref: string } | undefined;
    let cursor = await it.next();
    while (!cursor.done) {
      const ev = cursor.value;
      if (ev.type === 'publish.progress') messages.push(ev.message);
      if (ev.type === 'publish.done')     result = { ref: ev.ref };
      if (ev.type === 'error')            return errorResponse(ev.message, 500);
      cursor = await it.next();
    }
    if (cursor.value) result = cursor.value;

    // Bust the target source's catalog cache so the store reflects the new
    // app on the next browse (instead of waiting out the 10-min TTL).
    const cfg = nexus.getSourcesConfig();
    const match = cfg.sources.find((s) => s.kind === 'oci' && s.name === registryTarget);
    if (match) nexus.catalog.bustSource(match.name);
    else nexus.catalog.invalidate();

    return jsonResponse({ ok: true, source: 'oci', result, messages });
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
};
