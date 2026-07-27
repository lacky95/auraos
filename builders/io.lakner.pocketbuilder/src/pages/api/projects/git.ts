import type { APIRoute } from 'astro';
import { json, fail, readBody } from '../../../lib/api.ts';
import { APP_ID_RE } from '../../../lib/template.ts';
import { getProject, runTargetFor, updateRecord } from '../../../lib/projects.ts';
import { git, type ExecResult } from '../../../lib/docker.ts';
import { readGitStatus, parseStatus } from '../../../lib/git.ts';

interface Body {
  id:      string;
  action:  'status' | 'init' | 'commit' | 'remote' | 'push' | 'log';
  message?: string;
  url?:     string;
}

function step(name: string, r: ExecResult): { cmd: string; ok: boolean; output: string; via: string } {
  return { cmd: name, ok: r.ok, output: `${r.stdout}${r.stderr}`.trim(), via: r.via };
}

export const POST: APIRoute = async ({ request }) => {
  let body: Body;
  try { body = await readBody<Body>(request); }
  catch (err) { return fail((err as Error).message); }

  const { id, action } = body;
  if (!APP_ID_RE.test(id ?? '')) return fail(`Invalid project id '${id}'.`);

  const project = await getProject(id);
  if (!project) return fail(`'${id}' is not a Pocket Builder project.`, 404);
  if (!project.installed) return fail(`'${id}' is no longer installed.`, 404);

  const target = await runTargetFor(project);

  try {
    switch (action) {
      case 'status': {
        const { status, via, error } = await readGitStatus(target);
        if (error) return fail(error, 500, { via });
        return json({ ok: true, via, status });
      }

      case 'init': {
        const steps = [];
        for (const args of [['init', '-b', 'main'], ['add', '-A'], ['commit', '-m', 'Initial commit']]) {
          const r = await git(target, args);
          steps.push(step(`git ${args.join(' ')}`, r));
          if (!r.ok) break;
        }
        return json({ ok: steps.every((s) => s.ok), steps });
      }

      case 'commit': {
        const message = (body.message ?? '').trim();
        if (!message) return fail('A commit message is required.');
        const add = await git(target, ['add', '-A']);
        if (!add.ok) return json({ ok: false, steps: [step('git add -A', add)] });
        const commit = await git(target, ['commit', '-m', message]);
        return json({ ok: commit.ok, steps: [step('git add -A', add), step('git commit', commit)] });
      }

      case 'remote': {
        const url = (body.url ?? '').trim();
        if (!url) return fail('A remote URL is required.');
        // `remote add` fails when origin exists; fall through to set-url.
        let r = await git(target, ['remote', 'add', 'origin', url], 30_000);
        if (!r.ok) r = await git(target, ['remote', 'set-url', 'origin', url], 30_000);
        if (r.ok) await updateRecord(id, { gitRemote: url });
        return json({ ok: r.ok, steps: [step('git remote', r)] });
      }

      case 'push': {
        const branch = parseStatus((await git(target, ['status', '--porcelain=v1', '-b'])).stdout).branch ?? 'main';
        const r = await git(target, ['push', '-u', 'origin', branch], 180_000);
        return json({ ok: r.ok, steps: [step(`git push -u origin ${branch}`, r)] });
      }

      case 'log': {
        const r = await git(target, ['log', '--oneline', '-n', '20'], 30_000);
        return json({ ok: r.ok, log: r.ok ? r.stdout.trim() : '', steps: [step('git log', r)] });
      }

      default:
        return fail(`Unknown action '${action}'.`);
    }
  } catch (err) {
    return fail((err as Error).message, 500);
  }
};
