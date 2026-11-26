import type { APIRoute } from 'astro';
import { writeFileSync, chmodSync, unlinkSync, lstatSync, existsSync, readlinkSync } from 'node:fs';
import { auditOwner, ownerAction } from '../../../lib/approvals/admin.ts';
import { installAuraShimRequest } from '../../../lib/approvals/maintenance.ts';

/**
 * Replace the (symlinked) /os/toolchain/bin/aura with a real shell-wrapper
 * script. PRoot's `--bind=<src>:<dst>` raises EINVAL on readlink when `<src>`
 * is itself a symlink — Node's realpathSync on the bound `/usr/local/bin/aura`
 * inside the sandbox then throws when resolving the entry point. A regular
 * wrapper script avoids the symlink entirely.
 *
 * The wrapper execs the current bundled CLI, which is still updated in-place
 * by the esbuild watcher — so we don't lose hot-reload of CLI edits.
 *
 * The owner's (lib/approvals/maintenance.ts): the owner and the host operator
 * directly, the System Terminal with one click.
 */
const TARGETS = ['/os/toolchain/bin/aura', '/usr/local/bin/aura'];
const WRAPPER = `#!/usr/bin/env bash
exec node /workspace/packages/aura-cli/dist/aura.cjs "$@"
`;

export const POST: APIRoute = async (ctx) => {
  const actor = await ownerAction(ctx, installAuraShimRequest(TARGETS));
  if (actor instanceof Response) return actor;
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
  const failed = Object.keys(report).some((k) => k.endsWith('.error'));
  await auditOwner(actor, 'os.install-aura-shim', { outcome: failed ? 'failed' : 'ok' });
  return new Response(JSON.stringify(report, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
