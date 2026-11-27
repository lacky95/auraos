// The release builder's throwaway container (Phase 6 stream B, D68; D106): the
// ONE `docker run` argv for code that is not trusted to run beside AuraOS: the
// release build's deps/build/check steps (builder.mjs) and the check mode
// (check.mjs). Always `--rm`, no capabilities, no-new-privileges, an explicit
// network, the resources.limits profile (limits.mjs), and only the mounts the
// caller names: never the Docker socket, a home or the rest of /data.
import { subpathOf } from './layout.mjs';
import { limitArgs } from './limits.mjs';

/**
 * mounts: [{ type: 'volume'|'bind', source, target, subpath?, readonly? }]
 * env, labels: { KEY: value }; capAdd: capabilities kept after --cap-drop ALL (default none);
 * init: Docker's init as PID 1 (reaps orphaned processes); user: 'uid:gid' (omitted = the image's user); verb: run | create
 * (create: the caller inspects the container before `docker start -a`);
 * entrypoint + image come last, the caller appends the command.
 */
export function throwawayArgs({ verb = 'run', name, image, network, limits, workdir, mounts = [], env = {}, labels = {}, capAdd = [], init = false, user, entrypoint }) {
  if (!network) throw new Error('throwawayArgs: an explicit network is required');
  if (verb !== 'run' && verb !== 'create') throw new Error(`throwawayArgs: verb must be run or create, got ${verb}`);
  const a = [verb, '--rm', '--name', name, '--network', network, ...limitArgs(limits)];
  a.push('--cap-drop', 'ALL');
  for (const c of capAdd) a.push('--cap-add', c);
  a.push('--security-opt', 'no-new-privileges');
  if (init) a.push('--init');
  if (user) a.push('--user', user);
  a.push('--workdir', workdir);
  for (const m of mounts) {
    const sub = m.type === 'volume' && m.subpath ? `,volume-subpath=${m.subpath}` : '';
    a.push('--mount', `type=${m.type},source=${m.source},target=${m.target}${sub}${m.readonly ? ',readonly' : ''}`);
  }
  for (const [k, v] of Object.entries(labels)) a.push('--label', `${k}=${v}`);
  for (const [k, v] of Object.entries(env)) a.push('-e', `${k}=${v}`);
  a.push('--entrypoint', entrypoint, image);
  return a;
}

/**
 * The data-volume subpath of `abs` (a path under `dataRoot`) for a volume mount, when `dataRoot`
 * sits at `dataSubpath` inside the volume ('' or undefined = the volume's root).
 */
export function volumeSubpath(dataRoot, dataSubpath, abs) {
  const prefix = dataSubpath ? `${dataSubpath.replace(/^\/+|\/+$/g, '')}/` : '';
  if (prefix.split('/').includes('..')) throw new Error('dataSubpath must stay inside the volume');
  return `${prefix}${subpathOf(dataRoot, abs)}`;
}
