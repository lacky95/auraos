import type { APIRoute } from 'astro';
import { getAppManager, currentToolsMode, toolchainMirrorBin, listToolchainBinaries, readSidecarMap, sidecarNames, INSTANCE_LIB_DIR } from '@aura/core';
import { join } from 'node:path';
import { TERMINAL_APP_ID } from '../../../../server/terminal-embed.mjs';

/**
 * Lists the per-instance /aura/my-tools allowlist for an app, plus the
 * toolchain store it was provisioned from. Also backs the `aura cap grant`
 * picker's available-tools list, so it reports the MIRROR (what instances are
 * actually provisioned from) rather than /os/toolchain/bin — the two can
 * drift, and the picker must offer what an app can really receive.
 *
 * What is provisioned comes from the instance's runtime (`tools.status`,
 * 5b-2 D-C: hardlinks, legacy symlinks, the libraries a tool needs); this
 * route only reports it. `runtimeDir` is the kernel's tools layout, shown
 * for diagnosis.
 */
export const GET: APIRoute = ({ url }) => {
  const appId = url.searchParams.get('appId') ?? TERMINAL_APP_ID;
  const mgr = getAppManager();
  const dataDir = mgr.getDataDir();
  const mirrorBin = toolchainMirrorBin(dataDir);
  const mode = currentToolsMode(dataDir);

  const instances = mgr.getInstancesByApp(appId).map((i) => {
    const dir = join(dataDir, 'aura', 'runtime', i.instanceId, 'tools');
    const st = mgr.toolsStatusOf(i.instanceId) ?? { provisioned: false, entries: [], libs: null };
    return {
      instanceId: i.instanceId,
      inPool: i.inPool,
      runtimeDir: dir,
      dirExists: st.provisioned,
      entryCount: st.entries.length,
      entries: st.entries,
      libDir: { path: join(dir, INSTANCE_LIB_DIR), exists: st.libs !== null, entries: st.libs ?? [] },
    };
  });

  // `storeEntries` feeds the tool pickers, so it lists only what a user can
  // meaningfully grant. A sidecar (e.g. `codex-code-mode-host`) is part of its
  // owner's grant, never a choice of its own — reported separately so the
  // picker can say "codex (+1 helper)" instead of offering the helper.
  const sidecars = readSidecarMap(mirrorBin);
  const helpers = sidecarNames(sidecars);
  return new Response(JSON.stringify({
    mode,
    toolBinDir: mirrorBin,
    storeEntries: listToolchainBinaries(mirrorBin).filter((n) => !helpers.has(n)),
    sidecars,
    instances,
  }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
