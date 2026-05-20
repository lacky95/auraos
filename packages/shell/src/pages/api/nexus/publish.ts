import type { APIRoute } from 'astro';
import { getNexusManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../lib/appResponse.js';

/**
 * Publish an app from a local path. v1: Git is the working path; OCI
 * shells out to `oras` if available, otherwise returns a clear error
 * the CLI surfaces to the user.
 *
 * Body:
 *   {
 *     path:     string,      // local app dir
 *     source?:  'git' | 'oci',  // default 'git'
 *     repo?:    string,      // git target (overrides manifest.publish.repo)
 *     registry?: string,     // oci target (overrides manifest.publish.registry)
 *     tag?:     string,
 *     channel?: string,
 *     branch?:  string,
 *   }
 */
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({})) as {
    path?:    string;
    source?:  'git' | 'oci';
    repo?:    string;
    registry?: string;
    tag?:     string;
    channel?: string;
    branch?:  string;
  };
  if (!body.path) return errorResponse('missing `path`', 400);

  const source = body.source ?? 'git';
  const nexus = getNexusManager();

  try {
    if (source === 'git') {
      const it = nexus.publishGit({
        appPath: body.path,
        repo:    body.repo,
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
    if (!body.registry) return errorResponse('missing `registry` for OCI publish', 400);
    const it = nexus.publishOci({
      appPath:  body.path,
      registry: body.registry,
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
    return jsonResponse({ ok: true, source: 'oci', result, messages });
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
};
