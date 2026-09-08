/**
 * Shared libraries — keeping a dynamically-linked capability whole across the
 * sandbox boundary.
 *
 * The bug this exists to fix: `apt-get install` runs inside `aura-shell`, so a
 * cap's `.so` files land in the SHELL's /usr/lib. The binary is then copied into
 * the toolchain and hardlinked into each app's allowlist dir — but nothing ever
 * carried the libraries. A PRoot app happened to work because `cap install` also
 * copied the `ldd` graph into /os/base-rootfs (PRoot's `/`). A container app has
 * no such tree: it runs the `aura-base` image and sees exactly one thing from the
 * toolchain, the flat readonly dir of binaries at /aura/my-tools. So `adb`
 * installed cleanly, appeared on PATH, and died on every run with
 * "libbase.so.0: cannot open shared object file".
 *
 * This module is the library-level twin of the sidecar system in
 * `tool-provision.ts`: a store, a manifest map keyed by owner, and expansion at
 * provision time. Libraries for GRANTED tools are materialised into
 * `<instance>/tools/.lib`, which every sandbox already sees as
 * `/aura/my-tools/.lib` through the mount it already has — so the grant stays
 * the boundary and no new mount is needed.
 *
 * It lives in @aura/core rather than in the shell's install route so it can be
 * unit-tested: core's tests import from `dist/`, and an Astro API route cannot
 * be imported at all.
 */
import {
  copyFileSync, existsSync, mkdirSync, openSync, readSync, closeSync,
  readFileSync, writeFileSync, readdirSync, lstatSync, unlinkSync, linkSync, rmSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Manifest filename inside a toolchain BIN dir: `{ owner: LibDep[] }`.
 *
 * It sits beside `.sidecars.json`, in the bin dir rather than the lib dir, for
 * one reason: that is the dir `provisionAllowlist` already enumerates, so a
 * grant and its libraries are resolved against one consistent view of the
 * store. Dotfile on purpose — `listToolchainBinaries` skips dotfiles, so it can
 * never be mistaken for a grantable binary.
 */
export const LIB_MANIFEST = '.libs.json';

/**
 * Subdir of a per-instance allowlist dir holding the granted tools' libraries.
 * Dotted so it stays out of `listToolchainBinaries` and out of tool pickers.
 */
export const INSTANCE_LIB_DIR = '.lib';

/** Toolchain lib store inside the aura-app-data volume — the twin of
 *  `toolchainMirrorBin`. Volume-backed, so it survives a container recreate,
 *  and on the same filesystem as the per-instance dirs, which is what lets
 *  `provisionAllowlist` hardlink from it. */
export function toolchainMirrorLib(dataDir: string): string {
  return join(dataDir, 'aura', 'toolchain', 'lib');
}

/** The lib store that sits beside a toolchain bin dir (`<toolchain>/lib`). */
export function toolchainLibFor(binDir: string): string {
  return join(dirname(binDir), 'lib');
}

/** How a dependency was classified at install time. */
export type LibKind =
  /** Not in the baseline; copied into the lib stores and shipped with the tool. */
  | 'staged'
  /** Present and identical in every sandbox; deliberately never staged. */
  | 'baseline'
  /** `ldd` could not resolve it even in the shell — the tool is already broken. */
  | 'missing';

export interface LibDep {
  /**
   * The DT_NEEDED string — what the dynamic loader actually searches for.
   * This, NOT `basename(origin)`, is the name a staged file must take:
   * `libusb-1.0.so.0` resolves to the real file `libusb-1.0.so.0.3.0`, and
   * `copyFileSync` dereferences, so storing it under the resolved name would
   * produce a file the loader never asks for.
   */
  soname: string;
  /** Absolute path it resolved to at install time; `null` when unresolvable. */
  origin: string | null;
  kind: LibKind;
}

/** Owner binary name → the libraries that must travel with it. */
export type LibMap = Record<string, LibDep[]>;

export type Linkage = 'dynamic' | 'static' | 'script' | 'unreadable';

export interface LinkageReport {
  linkage: Linkage;
  deps: LibDep[];
}

/**
 * Sonames we deliberately never stage.
 *
 * Deliberately NARROW: it is only the set where overriding the sandbox's own
 * copy is actively dangerous — the loader, libc and the compiler runtime, which
 * must match the `ld.so` actually executing. All three environments are Debian
 * 12 bookworm (`aura-shell` = node:22-slim, app containers = node:22,
 * base-rootfs = debian:bookworm-slim), so these are identical everywhere.
 *
 * Everything else stages, even if the target image probably has it. Staging a
 * redundant library costs a hardlink; failing to stage a needed one is the bug
 * this module exists to fix.
 */
export const BASELINE_SONAMES: ReadonlySet<string> = new Set([
  'ld-linux-x86-64.so.2', 'ld-linux.so.2', 'ld-linux-aarch64.so.1', 'linux-vdso.so.1',
  'libc.so.6', 'libm.so.6', 'libdl.so.2', 'libpthread.so.0', 'librt.so.1',
  'libresolv.so.2', 'libutil.so.1', 'libstdc++.so.6', 'libgcc_s.so.1',
]);

/** Strip ldd's trailing load address: `… (0x00007f…)`. */
function stripAddress(s: string): string {
  return s.replace(/\s*\(0x[0-9a-fA-F]+\)\s*$/, '').trim();
}

/**
 * Parse `ldd` stdout. Pure, so the classification rules are unit-testable
 * without a real binary on disk.
 *
 * Handles every line shape ldd emits:
 *   `\tlibfoo.so.1 => /usr/lib/libfoo.so.1.2.3 (0x00007f…)`  → resolved
 *   `\tlibfoo.so.1 => not found`                              → missing
 *   `\tlinux-vdso.so.1 (0x00007f…)`                           → no `=>` at all
 *   `\t/lib64/ld-linux-x86-64.so.2 (0x00007f…)`               → the loader itself
 *   `\tstatically linked`                                     → nothing to stage
 *
 * The regex this replaces (`/=>\s+(\/\S+)\s/`) required trailing whitespace
 * after the path, so a resolved line printed without a load address was
 * silently dropped, and it threw away the soname — the one string that matters.
 */
export function parseLdd(output: string): LinkageReport {
  const deps: LibDep[] = [];
  const seen = new Set<string>();
  let sawStatic = false;

  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('statically linked')) { sawStatic = true; continue; }
    if (line.startsWith('not a dynamic executable')) { sawStatic = true; continue; }

    const arrow = line.indexOf('=>');
    let soname: string;
    let origin: string | null;

    if (arrow === -1) {
      // `linux-vdso.so.1 (0x…)` or a bare loader path — no target to record.
      const name = stripAddress(line);
      if (!name) continue;
      soname = basename(name);
      origin = isAbsolute(name) ? name : null;
    } else {
      soname = line.slice(0, arrow).trim();
      const rhs = stripAddress(line.slice(arrow + 2));
      origin = rhs === 'not found' || rhs === '' ? null : rhs;
    }
    if (!soname || seen.has(soname)) continue;
    seen.add(soname);

    const kind: LibKind = BASELINE_SONAMES.has(soname)
      ? 'baseline'
      : (origin ? 'staged' : 'missing');
    deps.push({ soname, origin, kind });
  }

  if (deps.length === 0 && sawStatic) return { linkage: 'static', deps: [] };
  return { linkage: deps.length ? 'dynamic' : 'static', deps };
}

/** Sniff a file that `ldd` refused, so a shell script isn't reported as broken. */
function sniffNonElf(path: string): Linkage {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(4);
    const n = readSync(fd, buf, 0, 4, 0);
    if (n >= 2 && buf[0] === 0x23 && buf[1] === 0x21) return 'script';       // '#!'
    if (n >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
      return 'static';                                                        // ELF, no dyn section
    }
    return 'script';
  } catch {
    return 'unreadable';
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * Resolve a binary's dependency graph. `ldd` already resolves transitively, so
 * one pass gets the whole graph.
 *
 * `exec` is injectable so tests never have to shell out to a real binary.
 */
export function readLinkage(
  binaryPath: string,
  exec: (cmd: string) => string = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString(),
): LinkageReport {
  let out: string;
  try {
    out = exec(`ldd ${JSON.stringify(binaryPath)}`);
  } catch {
    // Non-zero exit is ldd's answer for "not a dynamic executable" — a static
    // binary or a shell script (the `aura` cap is a shim script), not a failure.
    return { linkage: sniffNonElf(binaryPath), deps: [] };
  }
  return parseLdd(out);
}

// ── the manifest on disk ─────────────────────────────────────────────────────

/** Read the lib map from a toolchain bin dir; `{}` when absent/corrupt. */
export function readLibMap(binDir: string): LibMap {
  const path = join(binDir, LIB_MANIFEST);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: LibMap = {};
    for (const [owner, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const deps: LibDep[] = [];
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const d = item as Record<string, unknown>;
        if (typeof d['soname'] !== 'string' || !d['soname']) continue;
        deps.push({
          soname: d['soname'],
          origin: typeof d['origin'] === 'string' ? d['origin'] : null,
          kind: d['kind'] === 'baseline' || d['kind'] === 'missing' ? d['kind'] : 'staged',
        });
      }
      out[owner] = deps;
    }
    return out;
  } catch {
    console.warn(`[tools] ignoring unreadable ${path}`);
    return {};
  }
}

export function writeLibMap(binDir: string, map: LibMap): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, LIB_MANIFEST), `${JSON.stringify(map, null, 2)}\n`);
}

/**
 * Record (or clear) one owner's libraries in every toolchain bin dir, so PRoot
 * and container apps resolve a grant against the same view. Mirrors
 * `setSidecars`, including the "always write, even when empty" rule: a tool that
 * stopped needing a library must not keep a stale entry that then shows up as
 * missing forever.
 */
export function setLibs(binDirs: readonly string[], owner: string, deps: readonly LibDep[]): void {
  for (const dir of binDirs) {
    try {
      const map = readLibMap(dir);
      if (deps.length) map[owner] = [...deps];
      else delete map[owner];
      writeLibMap(dir, map);
    } catch (err) {
      console.warn(`[tools] could not update ${join(dir, LIB_MANIFEST)}: ${(err as Error).message}`);
    }
  }
}

// ── staging into the stores ──────────────────────────────────────────────────

export interface StageResult {
  staged: string[];
  failed: string[];
}

/**
 * Copy every staged dep into each lib store, named by SONAME.
 *
 * Writes onto the existing path WITHOUT unlinking first: `copyFileSync`
 * truncates in place, preserving the inode, so per-instance `.lib` hardlinks
 * see the new content instead of being left on an orphaned old version. This is
 * the same reasoning `AppManager.syncToolchainMirror` documents for binaries —
 * and the trap `installBinary` fell into by unlinking first.
 */
export function stageLibs(deps: readonly LibDep[], libDirs: readonly string[]): StageResult {
  const staged: string[] = [];
  const failed: string[] = [];
  for (const dep of deps) {
    if (dep.kind !== 'staged' || !dep.origin || !existsSync(dep.origin)) continue;
    let ok = false;
    for (const dir of libDirs) {
      const dst = join(dir, dep.soname);
      try {
        mkdirSync(dir, { recursive: true });
        // A symlink would be followed by copyFileSync and clobber its target;
        // a regular file is truncated in place on purpose (see above).
        try { if (lstatSync(dst).isSymbolicLink()) unlinkSync(dst); } catch { /* absent */ }
        copyFileSync(dep.origin, dst);
        ok = true;
      } catch (err) {
        console.warn(`[cap] could not stage ${dep.soname} → ${dst}: ${(err as Error).message}`);
      }
    }
    (ok ? staged : failed).push(dep.soname);
  }
  return { staged, failed };
}

/**
 * Stage deps into a rootfs at their ORIGINAL absolute paths, so a sandbox whose
 * `/` is that tree resolves them with no `LD_LIBRARY_PATH` at all. Belt and
 * braces for PRoot, and the only thing that survives an exec that scrubs the
 * environment (`sudo`, `env -i`).
 *
 * Also writes a soname-named copy beside it when the resolved file has a
 * different name, because DT_NEEDED asks for the soname, not the real filename.
 */
export function stageIntoRootfs(deps: readonly LibDep[], rootfs: string): string[] {
  const added: string[] = [];
  for (const dep of deps) {
    if (!dep.origin || !existsSync(dep.origin)) continue;
    if (dep.kind === 'missing') continue;
    for (const name of new Set([basename(dep.origin), dep.soname])) {
      const dst = join(rootfs, dirname(dep.origin), name);
      if (existsSync(dst)) continue;
      try {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(dep.origin, dst);
        added.push(dst);
      } catch (err) {
        console.warn(`[cap] could not stage ${dep.soname} → ${dst}: ${(err as Error).message}`);
      }
    }
  }
  return added;
}

/**
 * Put libraries back at their original absolute paths under `root` from the
 * volume-backed store. This is what makes a container recreate survivable: the
 * apt-installed `.so` files lived in the shell's writable layer and in
 * /os/base-rootfs (an image layer), so both are thrown away — while the store
 * on the named volume still has them, keyed by soname.
 *
 * Only ever ADDS paths that are absent, exactly like the binary restore pass.
 */
export function restoreLibsFromStore(map: LibMap, libStore: string, root: string): string[] {
  const restored: string[] = [];
  const done = new Set<string>();
  for (const deps of Object.values(map)) {
    for (const dep of deps) {
      if (!dep.origin || dep.kind !== 'staged') continue;
      const src = join(libStore, dep.soname);
      if (!existsSync(src)) continue;
      for (const name of new Set([basename(dep.origin), dep.soname])) {
        const dst = join(root, dirname(dep.origin), name);
        if (done.has(dst) || existsSync(dst)) continue;
        done.add(dst);
        try {
          mkdirSync(dirname(dst), { recursive: true });
          copyFileSync(src, dst);
          restored.push(dst);
        } catch (err) {
          console.warn(`[tools] could not restore ${dep.soname} → ${dst}: ${(err as Error).message}`);
        }
      }
    }
  }
  return restored;
}

// ── grant expansion ──────────────────────────────────────────────────────────

/**
 * The union of staged sonames the given binaries need. This is what keeps the
 * grant a boundary: an instance's `.lib` holds libraries for the tools it was
 * actually granted, never the whole store.
 */
export function libsForBinaries(names: Iterable<string>, map: LibMap): string[] {
  const out = new Set<string>();
  for (const name of names) {
    for (const dep of map[name] ?? []) {
      if (dep.kind === 'staged') out.add(dep.soname);
    }
  }
  return [...out].sort();
}

/**
 * Sonames only `owner` references — safe to delete when it is uninstalled.
 *
 * An owner with NO entry in the map contributes no references, which would make
 * its libraries look orphaned the moment some other cap is removed. Those are
 * caps installed before libraries were tracked, so they are treated as unknown
 * and nothing is freed on their behalf: `aura cap doctor --fix` writes their
 * entry, and only then does refcounting become exact.
 */
export function orphanedLibs(map: LibMap, owner: string): string[] {
  const mine = new Set((map[owner] ?? []).filter((d) => d.kind === 'staged').map((d) => d.soname));
  if (mine.size === 0) return [];
  for (const [other, deps] of Object.entries(map)) {
    if (other === owner) continue;
    for (const dep of deps) mine.delete(dep.soname);
  }
  return [...mine].sort();
}

/**
 * Sonames this owner would stage under a DIFFERENT origin than one already
 * recorded by another owner. The flat store holds one file per soname and the
 * loader can only resolve one, so this is reported rather than hidden.
 */
export function conflictingLibs(map: LibMap, owner: string, deps: readonly LibDep[]): string[] {
  const byName = new Map<string, string>();
  for (const [other, list] of Object.entries(map)) {
    if (other === owner) continue;
    for (const d of list) if (d.origin) byName.set(d.soname, d.origin);
  }
  const out: string[] = [];
  for (const d of deps) {
    if (d.kind !== 'staged' || !d.origin) continue;
    const existing = byName.get(d.soname);
    if (existing && existing !== d.origin) out.push(d.soname);
  }
  return out.sort();
}

// ── per-instance materialisation ─────────────────────────────────────────────

export interface MaterialiseResult {
  linked: string[];
  missing: string[];
}

/**
 * (Re)build `<toolsDir>/.lib` so it holds exactly `sonames`.
 *
 * Reconciles rather than empties: stale names are removed and missing ones
 * added, so a running app never sees the directory momentarily bare. The `.lib`
 * directory itself is created once and never replaced — a container binds the
 * parent dir BY INODE at spawn time, and the same care one level down keeps
 * `LD_LIBRARY_PATH` pointing at something that exists.
 *
 * Hardlink mode links from the volume-backed store. Symlink mode COPIES: that
 * mode exists precisely because hardlinks don't work here, and a symlink into
 * the store would dangle inside the sandbox, where the store isn't mounted.
 */
export function materialiseLibs(opts: {
  toolsDir: string;
  libStore: string;
  sonames: readonly string[];
  mode: 'hardlink' | 'symlink';
}): MaterialiseResult {
  const { toolsDir, libStore, sonames, mode } = opts;
  const dir = join(toolsDir, INSTANCE_LIB_DIR);
  const linked: string[] = [];
  const missing: string[] = [];

  mkdirSync(dir, { recursive: true });
  const wanted = new Set(sonames);

  for (const name of readdirSync(dir)) {
    if (wanted.has(name)) continue;
    try { rmSync(join(dir, name), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  for (const soname of wanted) {
    const src = join(libStore, soname);
    const dst = join(dir, soname);
    if (existsSync(dst)) { linked.push(soname); continue; }
    if (!existsSync(src)) { missing.push(soname); continue; }
    try {
      if (mode === 'hardlink') linkSync(src, dst);
      else copyFileSync(src, dst);
      linked.push(soname);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') { linked.push(soname); continue; }
      missing.push(soname);
    }
  }
  return { linked, missing };
}
