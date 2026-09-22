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
  existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { resolveToolBinaries, type SidecarMap } from './tool-allowlist.js';
import {
  INSTANCE_LIB_DIR, libsForBinaries, materialiseLibs, readLibMap, toolchainLibFor,
  toolchainMirrorLib,
} from './tool-libs.js';

/** Path the legacy ('symlink') mode binds the whole toolchain store at. */
export const ALL_TOOLS_PATH = '/aura/all-tools';
/** Path every sandbox gets its own allowlist dir at; prepended to PATH. */
export const MY_TOOLS_PATH = '/aura/my-tools';

/**
 * Where a sandbox finds the shared libraries of the tools it was granted.
 * It is a subdir of the allowlist dir on purpose — that dir is already
 * mounted into every sandbox, so libraries ride in on the mount the grant
 * already has and need no second one. A second mount would have to expose
 * the whole lib store, which is the same leak the 'hardlink' mode exists to
 * close.
 *
 * Referenced ONLY by the generated wrapper scripts (see `wrapperScript`),
 * never exported as a container-wide `LD_LIBRARY_PATH`: the staged libs are
 * the shell's Debian builds, and a global override shadows the same sonames
 * inside any image built against newer ones — a sidecar runtime shipping
 * OpenSSL 3.5 lost its Python `ssl` module to the staged 3.0 libcrypto that
 * way.
 */
export const MY_TOOLS_LIB_PATH = `${MY_TOOLS_PATH}/${INSTANCE_LIB_DIR}`;

/**
 * Subdir of a per-instance allowlist dir holding the REAL granted binaries
 * whenever the instance has staged libraries; the top-level entries are then
 * wrapper scripts that scope `LD_LIBRARY_PATH` to the tool's own process
 * tree. Dotted for the same reason as `.lib`: invisible to
 * `listToolchainBinaries` and to tool pickers. EVERY granted binary is linked
 * here, not just the owners with lib entries, so a tool that locates its
 * helpers relative to /proc/self/exe still finds them as siblings.
 */
export const INSTANCE_BIN_DIR = '.bin';
export const MY_TOOLS_BIN_PATH = `${MY_TOOLS_PATH}/${INSTANCE_BIN_DIR}`;

/**
 * The wrapper placed at `/aura/my-tools/<name>` when the instance's `.lib`
 * is non-empty. Prepends rather than assigns so a caller-supplied
 * LD_LIBRARY_PATH still wins for its own entries.
 */
export function wrapperScript(name: string): string {
  return [
    '#!/bin/sh',
    `export LD_LIBRARY_PATH="${MY_TOOLS_LIB_PATH}\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"`,
    `exec "${MY_TOOLS_BIN_PATH}/${name}" "\$@"`,
    '',
  ].join('\n');
}

/**
 * Sidecar map filename inside a toolchain bin dir: `{ owner: [helper, ...] }`.
 *
 * Written at install time, read at provision time, so the two ends agree on
 * which files form one tool without the provisioner having to know anything
 * about package layouts. Dotfile on purpose — `listToolchainBinaries` skips
 * dotfiles, so the map can never be mistaken for a grantable binary.
 */
export const SIDECAR_MANIFEST = '.sidecars.json';

/**
 * Bin dirs where a `<binary>-*` name match proves nothing: /usr/bin holds
 * thousands of unrelated programs, so `git` would adopt `git-lfs` and `apt`
 * would adopt `apt-get`. Auto-detection is therefore limited to directories a
 * single package owns (npm platform vendor dirs, curl-extracted trees), where
 * a `<binary>-` prefix really does mean "helper of this tool". An apt package
 * that ships a helper must name it via the registry's `sidecars:` field.
 */
const SYSTEM_BIN_DIRS = new Set([
  '/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/local/bin', '/usr/local/sbin',
]);

/** Read the sidecar map from a toolchain bin dir; `{}` when absent/corrupt. */
export function readSidecarMap(binDir: string): SidecarMap {
  const path = join(binDir, SIDECAR_MANIFEST);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: SidecarMap = {};
    for (const [owner, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(list)) out[owner] = list.filter((n): n is string => typeof n === 'string');
    }
    return out;
  } catch {
    // A corrupt map must not take the OS down: every tool still provisions,
    // multi-file ones just lose their helpers until the next cap install
    // rewrites the file.
    console.warn(`[tools] ignoring unreadable ${path}`);
    return {};
  }
}

/** Overwrite the sidecar map in a toolchain bin dir. */
export function writeSidecarMap(binDir: string, map: SidecarMap): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, SIDECAR_MANIFEST), `${JSON.stringify(map, null, 2)}\n`);
}

/**
 * Record (or, with an empty list, clear) one owner's helpers in every given
 * toolchain bin dir. Both the image-layer store and the volume mirror get the
 * same map so container- and proot-sandboxed apps resolve grants identically.
 */
export function setSidecars(binDirs: readonly string[], owner: string, names: readonly string[]): void {
  for (const dir of binDirs) {
    try {
      const map = readSidecarMap(dir);
      if (names.length) map[owner] = [...names];
      else delete map[owner];
      writeSidecarMap(dir, map);
    } catch (err) {
      console.warn(`[tools] could not update ${join(dir, SIDECAR_MANIFEST)}: ${(err as Error).message}`);
    }
  }
}

export interface DetectedSidecar {
  /** Name it takes in the toolchain bin dir (basename of `src`). */
  name: string;
  /** Absolute path it was found at. */
  src: string;
}

/**
 * Work out which extra files an installed capability needs.
 *
 * Automatic rule: any OTHER executable in the tool's own directory whose name
 * starts with `<binary>-`. That is the convention helper executables follow
 * (`codex` → `codex-code-mode-host`), so a new capability that ships one is
 * handled with no registry change at all. Restricted to package-owned dirs —
 * see SYSTEM_BIN_DIRS for why.
 *
 * `declared` is the escape hatch for anything the rule can't see: a helper
 * with an unrelated name, or one in a neighbouring directory. Entries may be
 * bare names, or paths relative to the binary's dir, or absolute.
 */
export function detectSidecars(opts: {
  binaryPath: string;
  binaryName: string;
  declared?: readonly string[];
}): DetectedSidecar[] {
  const { binaryPath, binaryName, declared } = opts;
  const dir = dirname(binaryPath);
  const self = basename(binaryPath);
  const found = new Map<string, string>();

  const isUsableFile = (abs: string): boolean => {
    try {
      const st = statSync(abs);
      return st.isFile() && (st.mode & 0o111) !== 0;
    } catch { return false; }
  };

  for (const d of declared ?? []) {
    const abs = isAbsolute(d) ? d : join(dir, d);
    if (basename(abs) === self) continue;
    if (isUsableFile(abs)) found.set(basename(abs), abs);
    else console.warn(`[tools] ${binaryName}: declared sidecar '${d}' not found at ${abs}`);
  }

  if (!SYSTEM_BIN_DIRS.has(dir)) {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { entries = []; }
    for (const name of entries) {
      if (name === self || name.startsWith('.')) continue;
      if (!name.startsWith(`${binaryName}-`)) continue;
      const abs = join(dir, name);
      if (isUsableFile(abs)) found.set(name, abs);
    }
  }

  return [...found.entries()].map(([name, src]) => ({ name, src })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Where a sandbox sees the current user's home — the mount point, not the
 * storage. The backing dir is per-user (`scopes/users/<id>/home`, see
 * scopes/home.ts); this path is deliberately the SAME for every user and
 * every sandbox, because each sandbox serves exactly one user and tools bake
 * absolute paths into their state (claude keys its project history by cwd,
 * ssh by config path). A per-user mount point would invalidate all of that
 * the moment a second user existed, and buys nothing: whose home it is, is
 * already decided by which dir gets mounted here.
 *
 * The master container reaches the same dir through a /home/aura symlink, so
 * "one user, one home" holds across every layer: log into `claude` (or `gh`,
 * or drop an ssh key) once in any terminal and every other sandbox sees it,
 * including after an `aura jump`. That sharing is deliberate — a single-user
 * dev OS trades sandbox-level home isolation for not logging in five times.
 */
export const SHARED_HOME_PATH = '/home/aura';


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
  /** Shared libraries materialised into `<dir>/.lib` for the granted tools. */
  libs: string[];
  /** Libraries a granted tool needs that the lib store doesn't have. */
  missingLibs: string[];
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
      // `.lib` is reconciled in place by materialiseLibs below, and `.bin`
      // by the loop after it, for the same mount-by-inode reason this loop
      // exists. Both must also be SKIPPED here: a non-recursive rmSync on a
      // directory throws ERR_FS_EISDIR, and the catch that used to wrap this
      // whole loop would have swallowed it and abandoned every entry after it.
      if (name === INSTANCE_LIB_DIR || name === INSTANCE_BIN_DIR) continue;
      try { rmSync(join(dir, name), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch { /* dir was already empty */ }

  const storeBin = mode === 'hardlink' ? mirrorBin : legacyStoreBin;
  // Read the map from the SAME dir we enumerate, so a grant and its helpers
  // are resolved against one consistent view of the store.
  const wanted = resolveToolBinaries(
    tools, listToolchainBinaries(storeBin), readSidecarMap(storeBin),
  );

  // Libraries BEFORE binaries: a hot-refresh is visible to a running app the
  // instant a dirent appears, so staging them the other way round opens a
  // window where the tool is on PATH but cannot load.
  const libStore = mode === 'hardlink' ? toolchainMirrorLib(dataDir) : toolchainLibFor(legacyStoreBin);
  const { linked: libs, missing: missingLibs } = materialiseLibs({
    toolsDir: dir,
    libStore,
    sonames: libsForBinaries(wanted, readLibMap(storeBin)),
    mode,
  });

  // Wrap whenever the instance carries staged libraries. Per-binary precision
  // is possible (the lib map knows its owners) but buys nothing: a wrapper on
  // a tool that needs no staged lib is a no-op, while a MISSED wrapper on one
  // that does is exactly the loader error this module exists to prevent.
  const wrap = libs.length > 0;

  // Reconcile `.bin` in place (same mount-by-inode care as `.lib`): the real
  // binaries live here and the top-level names become wrapper scripts. When
  // nothing needs wrapping the whole subdir goes away — path resolution walks
  // dirents per exec, so no running app holds a reference into it.
  const binDir = join(dir, INSTANCE_BIN_DIR);
  if (wrap) {
    mkdirSync(binDir, { recursive: true });
    const keep = new Set(wanted);
    try {
      for (const name of readdirSync(binDir)) {
        if (keep.has(name)) continue;
        try { rmSync(join(binDir, name), { recursive: true, force: true }); } catch { /* ignore */ }
      }
    } catch { /* already empty */ }
  } else {
    try { rmSync(binDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // EEXIST means a concurrent refresh already placed it — not a failure.
  const place = (src: string, dst: string): boolean => {
    try {
      if (mode === 'hardlink') linkSync(src, dst);
      else symlinkSync(src, dst);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EEXIST';
    }
  };

  const linked: string[] = [];
  const missing: string[] = [];
  for (const bin of wanted) {
    const src = mode === 'hardlink' ? join(mirrorBin, bin) : `${ALL_TOOLS_PATH}/${bin}`;
    let ok: boolean;
    if (wrap) {
      // Real binary first, wrapper second — a name must never be on PATH
      // before the file it execs exists.
      ok = place(src, join(binDir, bin));
      if (ok) {
        try { writeFileSync(join(dir, bin), wrapperScript(bin), { mode: 0o755 }); }
        catch { ok = false; }
      }
    } else {
      ok = place(src, join(dir, bin));
    }
    (ok ? linked : missing).push(bin);
  }
  if (missing.length) {
    console.warn(
      `[tools] ${dir}: granted but unavailable in the toolchain — ${missing.join(', ')}. ` +
      `Install with \`aura cap install <name>\`.`,
    );
  }
  if (missingLibs.length) {
    // A binary whose libraries are absent is worse than an absent binary: it
    // is on PATH and fails at exec with a loader error that looks nothing like
    // a missing grant. Name it here rather than let it surface that way.
    console.warn(
      `[tools] ${dir}: granted tools need libraries the store doesn't have — ${missingLibs.join(', ')}. ` +
      `Repair with \`aura cap doctor --fix\`.`,
    );
  }
  return { mode, linked, missing, libs, missingLibs };
}
