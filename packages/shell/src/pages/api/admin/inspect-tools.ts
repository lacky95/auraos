import type { APIRoute } from 'astro';
import { getAppManager, currentToolsMode, toolchainMirrorBin, listToolchainBinaries, readSidecarMap, sidecarNames, readLibMap, INSTANCE_LIB_DIR } from '@aura/core';
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

  const libMap = readLibMap(mirrorBin);
  const instances = mgr.getInstancesByApp(appId).map((i) => {
    const dir = join(dataDir, 'aura', 'runtime', i.instanceId, 'tools');
    let entries: Array<{ name: string; kind: string; target: string | null; resolves: boolean }> = [];
    if (existsSync(dir)) {
      // Dotfiles are not tools: `.lib` is the granted libraries' dir, and
      // reporting it as an entry would both inflate entryCount (which the
      // grant picker reads) and classify a directory as kind:'unknown' — a
      // broken-looking tool that isn't one.
      entries = readdirSync(dir).filter((n) => !n.startsWith('.')).map((name) => {
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
        // `resolves` used to mean only "the file is there", which is exactly
        // the blind spot that let a cap whose shared libraries were missing
        // report healthy right up until someone ran it.
        const needed = (libMap[name] ?? []).filter((d) => d.kind === 'staged');
        const missing = needed
          .filter((d) => !existsSync(join(dir, INSTANCE_LIB_DIR, d.soname)))
          .map((d) => d.soname);
        return {
          name, kind, target,
          resolves: resolves && missing.length === 0,
          libs: { needed: needed.length, missing },
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
      libDir: (() => {
        const p = join(dir, INSTANCE_LIB_DIR);
        const exists = existsSync(p);
        return { path: p, exists, entries: exists ? readdirSync(p).sort() : [] };
      })(),
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
