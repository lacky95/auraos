// The release builder's throwaway container (Phase 6 stream B, D68; D106): the
// ONE `docker run` argv for code that is not trusted to run beside AuraOS: the
// release build's deps/build/check steps (builder.mjs) and the check mode
// (check.mjs). Always `--rm`, no capabilities, no-new-privileges, an explicit
// network, the resources.limits profile (limits.mjs), and only the mounts the
// caller names: never the Docker socket, a home or the rest of /data.
import { limitArgs } from './limits.mjs';

/**
 * mounts: [{ type: 'volume'|'bind', source, target, subpath?, readonly? }]
 * env: { KEY: value }; user: 'uid:gid' (omitted = the image's user);
 * entrypoint + image come last, the caller appends the command.
 */
export function throwawayArgs({ name, image, network, limits, workdir, mounts = [], env = {}, user, entrypoint }) {
  if (!network) throw new Error('throwawayArgs: an explicit network is required');
  const a = ['run', '--rm', '--name', name, '--network', network, ...limitArgs(limits)];
  a.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');
  if (user) a.push('--user', user);
  a.push('--workdir', workdir);
  for (const m of mounts) {
    const sub = m.type === 'volume' && m.subpath ? `,volume-subpath=${m.subpath}` : '';
    a.push('--mount', `type=${m.type},source=${m.source},target=${m.target}${sub}${m.readonly ? ',readonly' : ''}`);
  }
  for (const [k, v] of Object.entries(env)) a.push('-e', `${k}=${v}`);
  a.push('--entrypoint', entrypoint, image);
  return a;
}
