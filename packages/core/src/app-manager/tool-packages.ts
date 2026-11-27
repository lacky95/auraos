/**
 * Package trees — keeping a tool whole when it is a directory, not a file.
 *
 * The bug this exists to fix: Codex 0.172 locates itself through
 * `/proc/self/exe` and expects the rest of its npm platform package beside it
 * (`<exe>/../codex-package.json`, `codex-resources/bwrap`, `codex-path/rg`).
 * The capability store held only `bin/codex` and its `codex-code-mode-host`
 * sidecar, flat, so every sandbox ran a lone executable: the TUI refused to
 * start ("this CLI has no complete local package") and the sandbox panicked
 * ("no bundled codex-resources/bwrap binary was found next to the Codex
 * executable"). `CODEX_MANAGED_PACKAGE_ROOT` does not help — only the
 * exe-relative layout does.
 *
 * The third twin of the sidecar map (`.sidecars.json`) and the lib map
 * (`.libs.json`): a registry `package_root` makes `cap install` copy that
 * whole tree into `<bin>/.pkg/<owner>` of both toolchain stores and record the
 * executable's path inside it in `.packages.json`. Provisioning then rebuilds
 * the tree for GRANTED owners only, in the instance's `.pkg` (real dirs,
 * hardlinked files), and the top-level name becomes a wrapper that execs the
 * in-package executable, so `/proc/self/exe` lands inside the package. No new
 * mount, no whole-store bind: an ungranted package is absent, exactly like an
 * ungranted binary.
 *
 * In legacy 'symlink' mode the store is already bound at /aura/all-tools, and
 * `.pkg` sits inside the bin dir on purpose, so the wrapper points there and
 * nothing is copied per instance.
 */
import {
  chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/**
 * Package map filename inside a toolchain bin dir: `{ owner: entry }`, where
 * `entry` is the executable's path relative to the package root
 * (`bin/codex`). Dotfile, so `listToolchainBinaries` never offers it.
 */
export const PACKAGE_MANIFEST = '.packages.json';

/**
 * Subdir holding package trees, `<dir>/.pkg/<owner>/`, in a toolchain bin dir
 * and in an instance allowlist dir alike. Dotted for the same reason as
 * `.lib` and `.bin`.
 */
export const PACKAGE_DIR = '.pkg';

export type PackageMap = Record<string, string>;

/** Read the package map from a toolchain bin dir; `{}` when absent/corrupt. */
export function readPackageMap(binDir: string): PackageMap {
  const path = join(binDir, PACKAGE_MANIFEST);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: PackageMap = {};
    for (const [owner, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entry === 'string' && isPackageEntry(entry)) out[owner] = entry;
    }
    return out;
  } catch {
    // Same contract as the sidecar map: a corrupt file costs the package
    // (provisioning falls back to the flat binary), never the OS.
    console.warn(`[tools] ignoring unreadable ${path}`);
    return {};
  }
}

/** A relative, traversal-free path — the only shape a map entry may take. */
function isPackageEntry(entry: string): boolean {
  return !!entry && !isAbsolute(entry) && !entry.split('/').some((p) => p === '..' || p === '' || p === '.');
}

/**
 * Record (or, with `null`, clear) one owner's package entry in every given
 * toolchain bin dir.
 */
export function setPackage(binDirs: readonly string[], owner: string, entry: string | null): void {
  for (const dir of binDirs) {
    try {
      const map = readPackageMap(dir);
      if (entry) map[owner] = entry;
      else delete map[owner];
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, PACKAGE_MANIFEST), `${JSON.stringify(map, null, 2)}\n`);
    } catch (err) {
      console.warn(`[tools] could not update ${join(dir, PACKAGE_MANIFEST)}: ${(err as Error).message}`);
    }
  }
}

/** The executable's path inside its package root; throws when it lies outside. */
export function packageEntry(root: string, binaryPath: string): string {
  const rel = relative(root, binaryPath).split(sep).join('/');
  if (!isPackageEntry(rel)) throw new Error(`${binaryPath} is not inside its package root ${root}`);
  return rel;
}

/**
 * Copy the package tree at `root` into `<binDir>/.pkg/<owner>` of every given
 * store. Copied beside, then swapped by rename: an instance still hardlinked to
 * the old files keeps them, and its next provision re-links to the new ones.
 * A store package holds only dirs and files (see `copyTree`).
 */
export function stagePackage(root: string, binDirs: readonly string[], owner: string): void {
  for (const binDir of binDirs) {
    const dst = join(binDir, PACKAGE_DIR, owner);
    const staged = `${dst}.aura-new-${process.pid}`;
    mkdirSync(join(binDir, PACKAGE_DIR), { recursive: true });
    rmSync(staged, { recursive: true, force: true });
    copyTree(root, staged);
    rmSync(dst, { recursive: true, force: true });
    renameSync(staged, dst);
  }
}

/**
 * Copy a tree as plain dirs and files, so `linkTree` has only those to
 * mirror. A link to a file is copied as that file; a link to a directory is
 * skipped with a warning — Codex itself refuses those ("package contains a
 * directory link"), and following one could loop.
 */
function copyTree(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    const l = lstatSync(from);
    if (l.isDirectory()) { copyTree(from, to); continue; }
    let st: ReturnType<typeof statSync> | null = l;
    if (l.isSymbolicLink()) { try { st = statSync(from); } catch { st = null; } }
    if (st?.isFile()) {
      copyFileSync(from, to);
      chmodSync(to, st.mode & 0o7777);
    } else {
      console.warn(`[tools] package ${src}: skipping ${name} (not a file or directory)`);
    }
  }
}

/** Drop an owner's package tree from every given store. */
export function removePackage(binDirs: readonly string[], owner: string): void {
  for (const binDir of binDirs) {
    try { rmSync(join(binDir, PACKAGE_DIR, owner), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Copy every package `from` has and `to` lacks — the package half of
 * `AppManager.syncToolchainMirror`. Like its binary restore pass it only ever
 * ADDS, so it can never undo a `cap remove` or overwrite a newer install.
 */
export function syncPackages(fromBin: string, toBin: string): string[] {
  const src = join(fromBin, PACKAGE_DIR);
  if (!existsSync(src)) return [];
  const added: string[] = [];
  for (const owner of readdirSync(src)) {
    if (owner.includes('.aura-new-')) continue;
    const dst = join(toBin, PACKAGE_DIR, owner);
    if (existsSync(dst)) continue;
    try {
      stagePackage(join(src, owner), [toBin], owner);
      added.push(owner);
    } catch (err) {
      console.warn(`[tools] package ${owner} → ${dst} failed: ${(err as Error).message}`);
    }
  }
  return added;
}

/**
 * Rebuild `dst` as a copy of the tree at `src` whose files are hardlinks into
 * it, IN PLACE: entries that already share the store's inode stay, stale or
 * extra ones go. A store update swaps the tree by rename, so after one every
 * file here is stale and gets re-linked; a running process keeps the inode it
 * has open.
 */
function linkTree(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  const want = new Set(readdirSync(src));
  for (const name of readdirSync(dst)) {
    if (!want.has(name)) rmSync(join(dst, name), { recursive: true, force: true });
  }
  for (const name of want) {
    const s = lstatSync(join(src, name));
    const to = join(dst, name);
    let d: ReturnType<typeof lstatSync> | null = null;
    try { d = lstatSync(to); } catch { /* absent */ }
    if (s.isDirectory()) {
      if (d && !d.isDirectory()) rmSync(to, { force: true });
      linkTree(join(src, name), to);
    } else if (s.isFile()) {
      if (d && d.isFile() && d.ino === s.ino) continue;
      if (d) rmSync(to, { recursive: true, force: true });
      linkSync(join(src, name), to);
    }
  }
}

export interface MaterialisePackagesResult {
  /** Owners whose package is in place (hardlink mode) or reachable (symlink mode). */
  linked: string[];
  /** Owners with a map entry whose package the store lacks. */
  missing: string[];
}

/**
 * Make `<toolsDir>/.pkg` hold exactly the packages of `owners` that the store
 * has. Hardlink mode links them in (see `linkTree`); symlink mode keeps no
 * copy, because the wrapper reaches the store at /aura/all-tools. An owner the
 * store lacks is reported `missing`, and the caller falls back to the flat
 * binary rather than granting nothing.
 */
export function materialisePackages(opts: {
  toolsDir: string;
  storeBin: string;
  owners: readonly string[];
  mode: 'hardlink' | 'symlink';
}): MaterialisePackagesResult {
  const { toolsDir, storeBin, owners, mode } = opts;
  const dir = join(toolsDir, PACKAGE_DIR);
  const linked: string[] = [];
  const missing: string[] = [];
  const present = owners.filter((o) => {
    try { return lstatSync(join(storeBin, PACKAGE_DIR, o)).isDirectory(); } catch { return false; }
  });
  for (const o of owners) if (!present.includes(o)) missing.push(o);

  if (mode === 'symlink' || !present.length) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (mode === 'symlink') linked.push(...present);
    return { linked, missing };
  }

  mkdirSync(dir, { recursive: true });
  const keep = new Set(present);
  for (const name of readdirSync(dir)) {
    if (!keep.has(name)) rmSync(join(dir, name), { recursive: true, force: true });
  }
  for (const o of present) {
    try {
      linkTree(join(storeBin, PACKAGE_DIR, o), join(dir, o));
      linked.push(o);
    } catch (err) {
      console.warn(`[tools] ${toolsDir}: package ${o} could not be linked: ${(err as Error).message}`);
      missing.push(o);
    }
  }
  return { linked, missing };
}
