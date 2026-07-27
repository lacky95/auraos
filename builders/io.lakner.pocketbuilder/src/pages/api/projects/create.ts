import type { APIRoute } from 'astro';
import { json, fail, readBody } from '../../../lib/api.ts';
import { shellGet, shellPost } from '../../../lib/shellClient.ts';
import { renderTemplate, APP_ID_RE, TEMPLATES, PROJECT_ID_PREFIX } from '../../../lib/template.ts';
import { addRecord, scopeAppsDir, PROJECT_SCOPE, type AppDto } from '../../../lib/projects.ts';
import { git, prepareProject } from '../../../lib/docker.ts';

interface Body {
  id:       string;
  name:     string;
  template: string;
  initGit?: boolean;
}

/**
 * Create a project: render the template, hand it to the OS scaffolder, record
 * it as ours, optionally `git init`.
 *
 * The scaffold hop is what makes this work at all — we're inside a container
 * sandbox with a sliced /workspace/apps bind, so writing the files locally
 * would land in our own overlay where the AppManager never sees them. The
 * shell has the real mount. (Same reason `aura dev new` POSTs there.)
 */
export const POST: APIRoute = async ({ request }) => {
  let body: Body;
  try { body = await readBody<Body>(request); }
  catch (err) { return fail((err as Error).message); }

  const id       = (body.id ?? '').trim();
  const name     = (body.name ?? '').trim();
  const template = (body.template ?? '').trim();

  if (!APP_ID_RE.test(id)) {
    return fail(`Invalid project id '${id}'. Expected reverse-domain notation, e.g. ${PROJECT_ID_PREFIX}.myapp.`);
  }
  // Projects live under the builder's own namespace — that's what marks them
  // as ours at a glance and lets the list be rebuilt from app ids alone.
  if (!id.startsWith(`${PROJECT_ID_PREFIX}.`)) {
    return fail(`Project ids must start with '${PROJECT_ID_PREFIX}.' (got '${id}').`);
  }
  if (!name) return fail('A display name is required.');
  if (!TEMPLATES.some((t) => t.id === template)) return fail(`Unknown template '${template}'.`);

  // Refuse early on collision. The scaffold endpoint would also 409, but its
  // message talks about directories, not projects.
  try {
    const apps = await shellGet<AppDto[]>('/api/apps');
    if (apps.some((a) => a.manifest.id === id)) {
      return fail(`An app with id '${id}' is already installed.`, 409);
    }
  } catch (err) {
    return fail(`Could not reach the OS app registry: ${(err as Error).message}`, 502);
  }

  let files;
  try { files = renderTemplate(template, { APP_ID: id, APP_NAME: name }); }
  catch (err) { return fail((err as Error).message, 500); }

  try {
    await shellPost('/api/admin/scaffold', { appId: id, scope: PROJECT_SCOPE, files, force: false });
  } catch (err) {
    return fail(`Scaffold failed: ${(err as Error).message}`, 502);
  }

  const record = { id, name, template, createdAt: new Date().toISOString() };
  try { await addRecord(record); }
  catch (err) {
    // The app exists but we failed to claim it. Say so plainly — the user can
    // remove it with `aura app rm` — rather than pretending nothing happened.
    return fail(`Project scaffolded, but recording it failed: ${(err as Error).message}`, 500, { id });
  }

  // Install deps BEFORE the first start (see prepareProject) and before the
  // initial commit, so the lockfile npm writes lands in that commit rather
  // than showing up as an untracked file the moment the project first boots.
  const appsDir = await scopeAppsDir();
  let prepare: { ok: boolean; output: string };
  try {
    const r = await prepareProject(appsDir, id);
    prepare = { ok: r.ok, output: `${r.stdout}${r.stderr}`.trim().slice(-2000) };
  } catch (err) {
    prepare = { ok: false, output: (err as Error).message };
  }

  let gitResult: { ok: boolean; output: string } | null = null;
  if (body.initGit) {
    const target = { projectId: id, instanceId: null, scopeAppsDir: appsDir };
    const steps: string[][] = [
      ['init', '-b', 'main'],
      ['add', '-A'],
      ['commit', '-m', `Initial commit — scaffolded by Pocket Builder (${template})`],
    ];
    const out: string[] = [];
    let ok = true;
    for (const step of steps) {
      const r = await git(target, step);
      out.push(`$ git ${step.join(' ')}\n${r.stdout}${r.stderr}`.trim());
      if (!r.ok) { ok = false; break; }
    }
    gitResult = { ok, output: out.join('\n\n') };
  }

  // A failed prepare is not fatal — the project exists and the sandbox's own
  // entrypoint will retry the install on start. It just means that first start
  // may exceed the health window, so say so instead of hiding it.
  return json({ ok: true, id, name, template, prepare, git: gitResult });
};
