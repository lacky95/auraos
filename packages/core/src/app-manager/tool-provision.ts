/**
 * Materialise a manifest `tools[]` grant into an instance's allowlist dir.
 *
 * Two modes, picked automatically:
 *
 *   'hardlink' (default) — each granted binary becomes a HARDLINK from the
 *      toolchain mirror (`<dataDir>/aura/toolchain/bin`) into the instance's
 *      allowlist dir. A hardlink IS the file under a second name, so the
 *      sandbox needs no path to the shared store: an ungranted binary is
 *      simply absent from the sandbox. This is what makes `tools[]` an actual
 *      confinement boundary rather than PATH curation.
 *
 *   'symlink' (legacy fallback) — each granted binary becomes a symlink to
 *      `/aura/all-tools/<bin>`, which requires the runner to ALSO bind the
 *      whole toolchain store into the sandbox at that path. Every app can then
 *      reach every binary by absolute path, so the grant is advisory only.
 *      Used when the filesystem can't hardlink (some volume drivers) or before
 *      the mirror has been populated.
 *
 * Hot-refresh works identically in both modes: the sandbox mount is at the
 * DIRECTORY level, and both `link()` and `symlink()` are just "add a dirent",
 * so grant/revoke is visible to a running instance without a respawn.
 *
 * Callers must consult `currentToolsMode()` when building sandbox args — the
 * `/aura/all-tools` bind is required in 'symlink' mode and must be omitted in
 * 'hardlink' mode (leaving it is exactly the leak this module removes).
 */
import {
  existsSync, linkSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveToolBinaries } from './tool-allowlist.js';

/** Path the legacy ('symlink') mode binds the whole toolchain store at. */
export const ALL_TOOLS_PATH = '/aura/all-tools';
/** Path every sandbox gets its own allowlist dir at; prepended to PATH. */
export const MY_TOOLS_PATH = '/aura/my-tools';

export type ToolsMode = 'hardlink' | 'symlink';

/**
 * The toolchain copy that lives INSIDE the app-data volume. Both PRoot and
 * container instances hardlink from here: it is the only toolchain copy on the
 * same filesystem as the per-instance allowlist dirs (`/os/toolchain/bin` sits
 * on the shell image's overlay, so linking from it fails with EXDEV).
 */
export function toolchainMirrorBin(dataDir: string): string {
  return join(dataDir, 'aura', 'toolchain', 'bin');
}

/** Binary names in a toolchain dir, ignoring dotfiles (probe/temp leftovers). */
export function listToolchainBinaries(binDir: string): string[] {
  if (!existsSync(binDir)) return [];
  try { return readdirSync(binDir).filter((n) => !n.startsWith('.')); }
  catch { return []; }
}

/**
 * Whether this dataDir's filesystem supports hardlinks. A filesystem property,
 * so it's probed once and cached for the process lifetime. Probed under
 * dataDir itself (NOT inside the mirror) so a probe file can never be mistaken
 * for a toolchain binary.
 */
const linkableCache = new Map<string, boolean>();
export function supportsHardlinks(dataDir: string): boolean {
  const cached = linkableCache.get(dataDir);
  if (cached !== undefined) return cached;
  const src = join(dataDir, 'aura', '.linkprobe-src');
  const dst = join(dataDir, 'aura', '.linkprobe-dst');
  let ok = false;
  try {
    mkdirSync(join(dataDir, 'aura'), { recursive: true });
    writeFileSync(src, '');
    try { unlinkSync(dst); } catch { /* not present */ }
    linkSync(src, dst);
    ok = true;
  } catch {
    ok = false;
  } finally {
    try { unlinkSync(dst); } catch { /* ignore */ }
    try { unlinkSync(src); } catch { /* ignore */ }
  }
  linkableCache.set(dataDir, ok);
  if (!ok) {
    console.warn(
      `[tools] ${dataDir} cannot hardlink — falling back to symlink mode. ` +
      `Sandboxes will keep the shared ${ALL_TOOLS_PATH} mount, so tool grants are advisory only.`,
    );
  }
  return ok;
}

/**
 * Mode to use right now. Hardlinking additionally requires a populated mirror
 * — before `AppManager.syncToolchainMirror()` has run there is nothing to link
 * FROM, and silently provisioning an empty allowlist would break every app.
 * Re-evaluated per call (one cached bool + one readdir) so the first spawn
 * after the mirror lands picks hardlink mode up on its own.
 */
export function currentToolsMode(dataDir: string): ToolsMode {
  if (!supportsHardlinks(dataDir)) return 'symlink';
  return listToolchainBinaries(toolchainMirrorBin(dataDir)).length > 0 ? 'hardlink' : 'symlink';
}

export interface ProvisionResult {
  mode: ToolsMode;
  /** Binaries successfully materialised into the allowlist dir. */
  linked: string[];
  /** Granted names with no binary behind them (hardlink mode only). */
  missing: string[];
}

/**
 * (Re)build `dir` so it contains exactly the binaries `tools[]` grants.
 *
 * @param dataDir        the OS data dir (locates the mirror + decides the mode)
 * @param dir            the per-instance allowlist dir on the shell side
 * @param tools          manifest `tools[]` (may contain the '*' / '#' markers)
 * @param legacyStoreBin the dir this runner binds at `/aura/all-tools`, used to
 *                       enumerate the store in 'symlink' mode. PRoot binds the
 *                       real store; containers mount the mirror.
 */
export function provisionAllowlist(opts: {
  dataDir: string;
  dir: string;
  tools: string[];
  legacyStoreBin: string;
}): ProvisionResult {
  const { dataDir, dir, tools, legacyStoreBin } = opts;
  const mode = currentToolsMode(dataDir);
  const mirrorBin = toolchainMirrorBin(dataDir);

  // Empty the directory IN PLACE rather than rm+mkdir. A container's
  // `--mount …,volume-subpath=<this dir>` binds the dir BY INODE at spawn
  // time; rm-then-mkdir gives it a new inode and the container keeps pointing
  // at the unlinked-but-still-mounted old one, so every entry written after a
  // refresh is invisible inside the container ("command not found" for
  // everything the allowlist should provide).
  mkdirSync(dir, { recursive: true });
  try {
    for (const name of readdirSync(dir)) {
      try { rmSync(join(dir, name), { force: true }); } catch { /* ignore */ }
    }
  } catch { /* dir was already empty */ }

  const storeBin = mode === 'hardlink' ? mirrorBin : legacyStoreBin;
  const wanted = resolveToolBinaries(tools, listToolchainBinaries(storeBin));

  const linked: string[] = [];
  const missing: string[] = [];
  for (const bin of wanted) {
    const dst = join(dir, bin);
    try {
      if (mode === 'hardlink') linkSync(join(mirrorBin, bin), dst);
      else symlinkSync(`${ALL_TOOLS_PATH}/${bin}`, dst);
      linked.push(bin);
    } catch (err) {
      // EEXIST means a concurrent refresh already placed it — not a failure.
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') { linked.push(bin); continue; }
      missing.push(bin);
    }
  }
  if (missing.length) {
    console.warn(
      `[tools] ${dir}: granted but unavailable in the toolchain — ${missing.join(', ')}. ` +
      `Install with \`aura cap install <name>\`.`,
    );
  }
  return { mode, linked, missing };
}
