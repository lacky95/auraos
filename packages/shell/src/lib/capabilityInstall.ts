/**
 * Installing and removing capabilities in the master's shared toolchain
 * (SF-2): the executor behind `/api/admin/cap` (lib/capabilities.ts).
 *
 * Every definition it gets is validated (core capabilities/definition.ts) and
 * comes from a trusted registry. Nothing here runs a shell: programs run by
 * argv through `RunCommand` (lib/privilegedExec.ts), file work is Node fs.
 * apt verifies signatures; downloads are https only and must match their
 * sha256 before anything is unpacked or installed.
 *
 * Why the work happens in the shell process at all: `aura cap install` is
 * most often invoked from inside the Terminal, where apt cannot verify and
 * `/os/toolchain/bin` is not mounted. Routing through the master makes apt
 * work against the container's apt cache, and the binary lands in the
 * toolchain dir every future sandbox binds.
 */
import { accessSync, chmodSync, constants, copyFileSync, cpSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import {
  detectSidecars, readSidecarMap, setSidecars,
  readLinkage, stageLibs, stageIntoRootfs, setLibs, readLibMap, orphanedLibs, conflictingLibs,
  toolchainLibFor, toolchainMirrorLib, type CapabilityDefinition, type CapabilityStep, type LibDep,
} from '@aura/core';
import { aptInstallArgv, aptUpdateArgv, type RunCommand } from './privilegedExec.ts';

interface State {
  capabilities: Record<string, { installed: boolean; installedAt: string; version: string | null }>;
  services:     Record<string, unknown>;
}

export interface InstallResult { symlink: string; version: string | null; libsCopied: number; libs: LibDep[]; sidecars: string[] }

export interface CapabilityInstaller {
  install(name: string, def: CapabilityDefinition, force: boolean): Promise<InstallResult>;
  remove(name: string, def: CapabilityDefinition): void;
  loadState(): State;
  saveState(s: State): void;
}

export const STATE_PATH = process.env['AURA_STATE_PATH']    ?? '/data/aura/state/capabilities.json';
const TOOLCHAIN_BIN = join(process.env['AURA_TOOLCHAIN_DIR'] ?? '/os/toolchain', 'bin');
// Mirror of the toolchain inside the aura-app-data named volume. Container-
// sandbox apps mount this via --mount volume-subpath because they can't see
// /os/toolchain (it only lives inside the aura-shell image). Keep both in
// sync so wildcard-cap apps and explicit-grant apps see the same set of tools
// regardless of which sandbox they run in.
const TOOLCHAIN_BIN_MIRROR = join(process.env['AURA_DATA_DIR'] ?? '/data', 'aura', 'toolchain', 'bin');

function installBinary(src: string, dst: string, force = false): void {
  // Copy, don't symlink. PRoot's --bind on a symlink fails with EINVAL on
  // readlink (the ptrace translation can't follow bind-target symlinks),
  // which manifests as "command not found" inside proots even when the
  // binary clearly exists on the container. Real-file installs sidestep
  // the chained-resolution path entirely — every proot sees a plain file
  // in /aura/all-tools that translates one-hop to the store on the host.
  //
  // Always writes a second copy into the named-volume mirror so the cap is
  // visible to sibling-container apps too (they can't bind /os/toolchain).
  // See TOOLCHAIN_BIN_MIRROR above for the why.
  const binaryName = dst.startsWith(TOOLCHAIN_BIN + '/') ? dst.slice(TOOLCHAIN_BIN.length + 1) : null;
  const targets = binaryName
    ? [dst, join(TOOLCHAIN_BIN_MIRROR, binaryName)]
    : [dst];
  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true });
    // Unlink a SYMLINK only. A regular file is left in place for copyFileSync
    // to truncate, which preserves the inode — unlinking first would give the
    // mirror a new one and strand every existing per-instance hardlink on the
    // OLD binary until something happened to refresh it. Same reasoning as
    // AppManager.syncToolchainMirror.
    // Normally only symlinks are unlinked; a regular file is truncated so
    // per-instance hardlinks still resolve to the same inode. With force=true
    // we unlink regardless: that bypasses ETXTBSY when the binary is currently
    // being executed somewhere. The old inode stays alive for processes that
    // already have it open; refreshWildcardApps() below re-hardlinks the new
    // one into every running sandbox.
    try {
      const st = lstatSync(target);
      if (st.isSymbolicLink() || force) unlinkSync(target);
    } catch { /* not present */ }
    copyFileSync(src, target);
    try { chmodSync(target, 0o755); } catch { /* best effort */ }
  }
}

function loadState(): State {
  if (!existsSync(STATE_PATH)) return { capabilities: {}, services: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as Partial<State>;
    return { capabilities: parsed.capabilities ?? {}, services: parsed.services ?? {} };
  } catch { return { capabilities: {}, services: {} }; }
}
function saveState(s: State): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

/** Both toolchain bin dirs, in the order writes should land. */
const TOOLCHAIN_BIN_DIRS = [TOOLCHAIN_BIN, TOOLCHAIN_BIN_MIRROR] as const;
// The library stores, one per bin store. Flat and keyed by SONAME — the string
// the loader searches for — because the resolved file often has another name
// (`libusb-1.0.so.0` is really `libusb-1.0.so.0.3.0`) and copying dereferences.
const TOOLCHAIN_LIB_DIRS = [
  toolchainLibFor(TOOLCHAIN_BIN),
  toolchainMirrorLib(process.env['AURA_DATA_DIR'] ?? '/data'),
] as const;

/**
 * Install the capability's main binary AND every file that has to travel with
 * it, then record the relationship so `tools[]` can grant them as a unit.
 *
 * This is why it exists: a capability is not always one file. `codex` spawns
 * `codex-code-mode-host` as a sibling of its own executable, so copying only
 * the main binary produced a cap that installed cleanly and then reported
 * "host executable was not found" forever. Detection is automatic, so the next
 * multi-file tool needs no registry change.
 */
function installWithSidecars(
  src: string,
  binaryName: string,
  entry: { sidecars?: string[] },
  baseRootfs: string,
  force = false,
): { libsCopied: number; libs: LibDep[]; sidecars: string[] } {
  installBinary(src, join(TOOLCHAIN_BIN, binaryName), force);

  const found = detectSidecars({ binaryPath: src, binaryName, declared: entry.sidecars });
  for (const sc of found) installBinary(sc.src, join(TOOLCHAIN_BIN, sc.name), force);

  // Libraries are resolved for the whole unit — the tool AND its helpers — and
  // recorded under the owner, so a grant carries every file the tool needs.
  const deps = new Map<string, LibDep>();
  for (const file of [src, ...found.map((sc) => sc.src)]) {
    for (const dep of readLinkage(file).deps) {
      if (!deps.has(dep.soname)) deps.set(dep.soname, dep);
    }
  }
  const all = [...deps.values()];

  // Three destinations, on purpose:
  //  - the two flat lib stores feed each instance's `.lib` (both sandboxes);
  //  - base-rootfs takes them at their ORIGINAL paths, which is what still
  //    works for an exec that scrubs the environment (sudo, env -i).
  const conflicts = conflictingLibs(readLibMap(TOOLCHAIN_BIN), binaryName, all);
  const { staged } = stageLibs(all, TOOLCHAIN_LIB_DIRS);
  const intoRootfs = stageIntoRootfs(all, baseRootfs);
  setLibs(TOOLCHAIN_BIN_DIRS, binaryName, all);

  // Always write the map, even when empty: a tool that STOPPED shipping a
  // helper must not keep a stale entry that then shows up as `missing`.
  setSidecars(TOOLCHAIN_BIN_DIRS, binaryName, found.map((sc) => sc.name));
  if (found.length) {
    console.log(`[cap] ${binaryName}: +${found.length} sidecar(s) — ${found.map((sc) => sc.name).join(', ')}`);
  }
  if (staged.length) {
    console.log(`[cap] ${binaryName}: +${staged.length} shared librar${staged.length === 1 ? 'y' : 'ies'} — ${staged.join(', ')}`);
  }
  // A dependency ldd cannot resolve even HERE means the cap is already broken
  // and will fail at first run with a loader error that looks nothing like a
  // bad grant. Say so now rather than let it install clean and die later.
  const unresolved = all.filter((d) => d.kind === 'missing').map((d) => d.soname);
  if (unresolved.length) {
    console.warn(
      `[cap] ${binaryName}: ${unresolved.length} shared librar${unresolved.length === 1 ? 'y' : 'ies'} ` +
      `could NOT be resolved — ${unresolved.join(', ')}. The tool will fail at exec; ` +
      `check the package's dependencies.`,
    );
  }
  if (conflicts.length) {
    console.warn(
      `[cap] ${binaryName}: ${conflicts.join(', ')} already staged from a different path by another ` +
      `capability. The store holds one file per soname, so the newest install wins.`,
    );
  }
  return { libsCopied: staged.length + intoRootfs.length, libs: all, sidecars: found.map((sc) => sc.name) };
}


/** `which`, without a shell: the first executable `name` on PATH. */
function which(name: string): string | null {
  for (const dir of (process.env['PATH'] ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin').split(delimiter)) {
    const p = join(dir, name);
    try { accessSync(p, constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Download an https URL into `dir` and check it against its sha256 before anyone uses it. */
async function fetchChecked(run: RunCommand, url: string, sha256: string, dir: string): Promise<string> {
  const file = join(dir, 'download');
  run('curl', ['-fsSL', '--proto', '=https', '--proto-redir', '=https', '--retry', '2', '--max-time', '900', '-o', file, '--', url], { timeoutMs: 960_000 });
  const got = await sha256File(file);
  if (got !== sha256) throw new Error(`${url}: sha256 ${got} does not match the registry's ${sha256}; nothing installed`);
  return file;
}

/** Replace `to` with `from` (a directory), atomically enough: copy beside, then swap. */
function replaceDir(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  const staged = `${to}.aura-new-${process.pid}`;
  rmSync(staged, { recursive: true, force: true });
  cpSync(from, staged, { recursive: true, verbatimSymlinks: true });
  rmSync(to, { recursive: true, force: true });
  renameSync(staged, to);
}

/** `chmod -R a+rX`, in Node. */
function makeReadable(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  const exec = st.isDirectory() || (st.mode & 0o111) !== 0;
  chmodSync(path, (st.mode & 0o7777) | 0o444 | (exec ? 0o111 : 0));
  if (st.isDirectory()) for (const e of readdirSync(path)) makeReadable(join(path, e));
}

/** Copy a file into place beside the target, then rename: a running binary keeps its old inode (no ETXTBSY). */
function placeFile(src: string, path: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.aura-new-${process.pid}`;
  copyFileSync(src, tmp);
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

function writeFileAtomic(path: string, content: string | Buffer, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.aura-new-${process.pid}`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/** One structured step. Each is argv or fs work on validated data; none is a shell command. */
export async function runStep(run: RunCommand, step: CapabilityStep): Promise<void> {
  if ('apt' in step) {
    run(aptUpdateArgv()[0]!, aptUpdateArgv().slice(1), { timeoutMs: 120_000 });
    run('apt-get', aptInstallArgv(step.apt).slice(1), { timeoutMs: 600_000 });
    return;
  }
  if ('mkdir' in step) { for (const p of step.mkdir) mkdirSync(p, { recursive: true }); return; }
  if ('readable' in step) { makeReadable(step.readable); return; }
  if ('file' in step) { writeFileAtomic(step.file.path, step.file.content, parseInt(step.file.mode, 8)); return; }
  if ('symlink' in step) {
    mkdirSync(dirname(step.symlink.path), { recursive: true });
    const tmp = `${step.symlink.path}.aura-new-${process.pid}`;
    rmSync(tmp, { force: true });
    symlinkSync(step.symlink.target, tmp);
    renameSync(tmp, step.symlink.path);
    return;
  }
  if ('extract' in step && step.extract.unless_exists && existsSync(step.extract.unless_exists)) return;
  const work = mkdtempSync(join(tmpdir(), 'aura-cap-'));
  try {
    if ('download' in step) {
      const file = await fetchChecked(run, step.download.url, step.download.sha256, work);
      placeFile(file, step.download.to, parseInt(step.download.mode ?? '0755', 8));
      return;
    }
    if ('deb' in step) {
      const file = await fetchChecked(run, step.deb.url, step.deb.sha256, work);
      const deb = join(work, 'package.deb');
      renameSync(file, deb);
      run('apt-get', aptInstallArgv([deb]).slice(1), { timeoutMs: 600_000 });
      return;
    }
    const x = step.extract;
    const file = await fetchChecked(run, x.url, x.sha256, work);
    const out = join(work, 'out');
    mkdirSync(out);
    if (x.format === 'zip') {
      run('unzip', ['-q', '-o', file, '-d', out], { timeoutMs: 300_000 });
    } else {
      run('tar', ['-xzf', file, '-C', out, '--no-same-owner', ...(x.strip ? [`--strip-components=${x.strip}`] : []), '--', ...(x.members ?? [])], { timeoutMs: 600_000 });
    }
    const from = x.subdir ? join(out, x.subdir) : out;
    if (!existsSync(from)) throw new Error(`${x.url}: ${x.subdir ?? 'the archive'} is missing after unpacking`);
    if (x.members) {
      // Members are merged into `to` (which may be a shared dir such as /usr/local/bin).
      mkdirSync(x.to, { recursive: true });
      for (const e of readdirSync(from)) {
        const src = join(from, e);
        if (lstatSync(src).isFile()) placeFile(src, join(x.to, e), lstatSync(src).mode & 0o777);
        else cpSync(src, join(x.to, e), { recursive: true, force: true, verbatimSymlinks: true });
      }
    } else {
      replaceDir(from, x.to);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function liveCapabilityInstaller(run: RunCommand): CapabilityInstaller {
  const baseRootfs = process.env['AURA_BASE_ROOTFS'] ?? '/os/base-rootfs';
  return {
    loadState, saveState,
    async install(name, def, force) {
      const binaryName = def.binary ?? name;
      const link = join(TOOLCHAIN_BIN, binaryName);
      let version: string | null = null;
      let binary: string | null = null;
      switch (def.source) {
        case 'builtin':
          if (!def.binary_path || !existsSync(def.binary_path)) return { symlink: link, version: null, libsCopied: 0, libs: [], sidecars: [] };
          binary = def.binary_path;
          break;
        case 'apt':
          run(aptUpdateArgv()[0]!, aptUpdateArgv().slice(1), { timeoutMs: 120_000 });
          run('apt-get', aptInstallArgv([def.package!], { recommends: true }).slice(1), { timeoutMs: 600_000 });
          binary = def.binary_path && existsSync(def.binary_path) ? def.binary_path : which(binaryName);
          try { version = run('dpkg-query', ['-W', '-f=${Version}', '--', def.package!], { timeoutMs: 10_000 }) || null; } catch { /* ignore */ }
          break;
        case 'npm':
          run('npm', ['install', '-g', '--', def.package!], { timeoutMs: 900_000 });
          // Prefer an explicit binary_path: some packages (e.g. @openai/codex)
          // expose a JS launcher as their bin that only works from inside the
          // package tree, while the real executable lives in a platform dep.
          binary = def.binary_path && existsSync(def.binary_path) ? def.binary_path : which(binaryName);
          try { version = run('npm', ['view', '--', def.package!, 'version'], { timeoutMs: 30_000 }) || null; } catch { /* ignore */ }
          break;
        case 'steps':
          for (const step of def.steps ?? []) await runStep(run, step);
          binary = def.binary_path && existsSync(def.binary_path) ? def.binary_path : null;
          break;
      }
      if (!binary) throw new Error(`${name}: installed, but its binary '${def.binary_path ?? binaryName}' is missing`);
      return { symlink: link, version, ...installWithSidecars(binary, binaryName, def, baseRootfs, force) };
    },
    remove: (name, def) => removeToolchainEntry(name, def, run),
  };
}

function removeToolchainEntry(name: string, def: CapabilityDefinition, run: RunCommand): void {
  const binaryName = def.binary ?? name;
  // Take the helpers with it — an orphaned `codex-code-mode-host` in the store
  // would keep showing up in wildcard grants long after codex was removed.
  const doomed = [binaryName, ...(readSidecarMap(TOOLCHAIN_BIN)[binaryName] ?? [])];
  for (const bin of doomed) {
    for (const dir of TOOLCHAIN_BIN_DIRS) {
      try { unlinkSync(join(dir, bin)); } catch { /* not present */ }
    }
  }
  // Libraries go too, but only the ones no other capability still references —
  // several caps can share a soname, and the store holds one file per name.
  // A cap with no `.libs.json` entry (installed before libs were tracked)
  // contributes no references, so orphanedLibs deliberately frees nothing on
  // its behalf; `aura cap doctor --fix` backfills the entry first.
  for (const soname of orphanedLibs(readLibMap(TOOLCHAIN_BIN), binaryName)) {
    for (const dir of TOOLCHAIN_LIB_DIRS) {
      try { unlinkSync(join(dir, soname)); } catch { /* not present */ }
    }
  }
  setLibs(TOOLCHAIN_BIN_DIRS, binaryName, []);
  // Deliberately NOT un-staged from /os/base-rootfs: that tree has no
  // ownership model, and a stale .so there is inert.
  setSidecars(TOOLCHAIN_BIN_DIRS, binaryName, []);
  if (def.source === 'apt' && def.package) {
    try { run('apt-get', ['remove', '-y', '-q', '--', def.package], { timeoutMs: 300_000 }); } catch { /* ignore */ }
  } else if (def.source === 'npm' && def.package) {
    try { run('npm', ['uninstall', '-g', '--', def.package], { timeoutMs: 300_000 }); } catch { /* ignore */ }
  }
}

