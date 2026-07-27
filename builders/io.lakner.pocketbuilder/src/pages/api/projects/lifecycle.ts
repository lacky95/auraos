import type { APIRoute } from 'astro';
import { json, fail, readBody } from '../../../lib/api.ts';
import { shellPost } from '../../../lib/shellClient.ts';
import { APP_ID_RE } from '../../../lib/template.ts';
import { getProject, removeRecord, scopeAppsDir } from '../../../lib/projects.ts';
import { removeProjectDir, removeSiblings } from '../../../lib/docker.ts';

interface Body {
  id:     string;
  action: 'start' | 'stop' | 'remove';
}

/** Start / stop / delete a project. Thin wrapper over the OS lifecycle API. */
export const POST: APIRoute = async ({ request }) => {
  let body: Body;
  try { body = await readBody<Body>(request); }
  catch (err) { return fail((err as Error).message); }

  const { id, action } = body;
  if (!APP_ID_RE.test(id ?? '')) return fail(`Invalid project id '${id}'.`);

  const project = await getProject(id);
  if (!project) return fail(`'${id}' is not a Pocket Builder project.`, 404);

  try {
    switch (action) {
      case 'start': {
        const res = await shellPost<{ instanceId: string }>(`/api/apps/${encodeURIComponent(id)}/start`);
        return json({ ok: true, id, instanceId: res.instanceId });
      }
      case 'stop': {
        await shellPost(`/api/apps/${encodeURIComponent(id)}/stop`);
        return json({ ok: true, id });
      }
      case 'remove': {
        // Phase 1: let the OS stop instances + clean its KV. Its own rm -rf
        // targets the system apps dir and won't find a user-scope app, so it
        // reports removed:false — that's expected, not an error.
        try { await shellPost(`/api/apps/${encodeURIComponent(id)}/remove`); }
        catch (err) { console.warn(`[pocketbuilder] OS remove of ${id} reported: ${(err as Error).message}`); }
        // Phase 2: sweep sibling containers. Normally onDestroy already tore
        // them down, but a force-killed or crashed instance never ran it, and
        // once the app is gone nothing would ever adopt them again.
        const siblings = await removeSiblings(id).catch(() => [] as string[]);

        // Phase 3: delete the directory ourselves so the registry deregisters.
        const rm = await removeProjectDir(await scopeAppsDir(), id);
        await removeRecord(id);
        if (!rm.ok) {
          return fail(`Project deregistered, but deleting its files failed: ${rm.stderr.trim() || `exit ${rm.code}`}`, 500, { id });
        }
        return json({ ok: true, id, removed: true, siblingsRemoved: siblings.length });
      }
      default:
        return fail(`Unknown action '${action}'.`);
    }
  } catch (err) {
    return fail((err as Error).message, 502);
  }
};
