import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { existsSync, readdirSync, readlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

/** Debug helper — lists the per-instance /aura/my-tools dir on the container. */
export const GET: APIRoute = ({ url }) => {
  const appId = url.searchParams.get('appId') ?? 'com.aura.terminal';
  const toolBinDir = process.env['AURA_TOOLCHAIN_DIR']
    ? join(process.env['AURA_TOOLCHAIN_DIR'], 'bin')
    : '/os/toolchain/bin';
  const allTools = existsSync(toolBinDir) ? readdirSync(toolBinDir) : [];
  const instances = getAppManager().getInstancesByApp(appId).map((i) => {
    const dir = join('/data/aura/runtime', i.instanceId, 'tools');
    let entries: Array<{ name: string; target: string | null; targetExists: boolean }> = [];
    if (existsSync(dir)) {
      entries = readdirSync(dir).map((name) => {
        let target: string | null = null;
        try {
          if (lstatSync(join(dir, name)).isSymbolicLink()) target = readlinkSync(join(dir, name));
        } catch { /* ignore */ }
        return {
          name,
          target,
          targetExists: target ? existsSync(join(toolBinDir, name)) : false,
        };
      });
    }
    return {
      instanceId: i.instanceId,
      inPool: i.inPool,
      runtimeDir: dir,
      dirExists: existsSync(dir),
      entryCount: entries.length,
      entries,
    };
  });
  return new Response(JSON.stringify({
    toolBinDir,
    storeEntries: allTools,
    instances,
  }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
