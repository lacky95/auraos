import type { APIRoute } from 'astro';
import { writeFileSync, chmodSync, unlinkSync, lstatSync, existsSync, readlinkSync } from 'node:fs';

/**
 * Replace the (symlinked) /os/toolchain/bin/aura with a real shell-wrapper
 * script. PRoot's `--bind=<src>:<dst>` raises EINVAL on readlink when `<src>`
 * is itself a symlink — Node's realpathSync on the bound `/usr/local/bin/aura`
 * inside the sandbox then throws when resolving the entry point. A regular
 * wrapper script avoids the symlink entirely.
 *
 * The wrapper execs the current bundled CLI, which is still updated in-place
 * by the esbuild watcher — so we don't lose hot-reload of CLI edits.
 */
const TARGETS = ['/os/toolchain/bin/aura', '/usr/local/bin/aura'];
const WRAPPER = `#!/usr/bin/env bash
exec node /workspace/packages/aura-cli/dist/aura.cjs "$@"
`;

export const POST: APIRoute = () => {
  const report: Record<string, string> = {};
  for (const path of TARGETS) {
    try {
      if (existsSync(path)) {
        const st = lstatSync(path);
        if (st.isSymbolicLink()) {
          report[`${path}.was`] = `symlink → ${readlinkSync(path)}`;
          unlinkSync(path);
        } else {
          report[`${path}.was`] = 'regular file (replacing)';
          unlinkSync(path);
        }
      } else {
        report[`${path}.was`] = '(missing)';
      }
      writeFileSync(path, WRAPPER, { mode: 0o755 });
      chmodSync(path, 0o755);
      report[`${path}.now`] = 'wrapper script (exec node /workspace/packages/aura-cli/dist/aura.cjs)';
    } catch (err) {
      report[`${path}.error`] = (err as Error).message;
    }
  }
  return new Response(JSON.stringify(report, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
