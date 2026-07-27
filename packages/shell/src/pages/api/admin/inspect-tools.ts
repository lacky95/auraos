import type { APIRoute } from 'astro';
import { getAppManager, currentToolsMode, toolchainMirrorBin, listToolchainBinaries } from '@aura/core';
import { existsSync, readdirSync, readlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lists the per-instance /aura/my-tools allowlist for an app, plus the
 * toolchain store it was provisioned from. Also backs the `aura cap grant`
 * picker's available-tools list, so it reports the MIRROR (what instances are
 * actually provisioned from) rather than /os/toolchain/bin — the two can
 * drift, and the picker must offer what an app can really receive.
 *
 * Allowlist entries are hardlinks in the default mode and symlinks in legacy
 * mode, so both shapes are described: `kind` says which, `target` is set for
 * symlinks only, and `resolves` reports whether the entry leads to a binary.
 */
export const GET: APIRoute = ({ url }) => {
  const appId = url.searchParams.get('appId') ?? 'com.aura.terminal';
  const mgr = getAppManager();
  const dataDir = mgr.getDataDir();
  const mirrorBin = toolchainMirrorBin(dataDir);
  const mode = currentToolsMode(dataDir);

  const instances = mgr.getInstancesByApp(appId).map((i) => {
    const dir = join(dataDir, 'aura', 'runtime', i.instanceId, 'tools');
    let entries: Array<{ name: string; kind: string; target: string | null; resolves: boolean }> = [];
    if (existsSync(dir)) {
      entries = readdirSync(dir).map((name) => {
        const path = join(dir, name);
        let kind = 'unknown';
        let target: string | null = null;
        let resolves = false;
        try {
          const st = lstatSync(path);
          if (st.isSymbolicLink()) {
            kind = 'symlink';
            target = readlinkSync(path);
            // The target is a path INSIDE the sandbox (/aura/all-tools/<bin>),
            // so check the store dir it maps to instead of following it here.
            resolves = existsSync(join(mirrorBin, name));
          } else if (st.isFile()) {
            // Hardlink: nlink > 1 means the mirror still references it too.
            kind = st.nlink > 1 ? 'hardlink' : 'file';
            resolves = st.size > 0;
          }
        } catch { /* raced with a refresh */ }
        return { name, kind, target, resolves };
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
    mode,
    toolBinDir: mirrorBin,
    storeEntries: listToolchainBinaries(mirrorBin),
    instances,
  }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
