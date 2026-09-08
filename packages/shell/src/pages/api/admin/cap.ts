import type { APIRoute } from 'astro';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, lstatSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import {
  getAppManager, detectSidecars, readSidecarMap, setSidecars,
  readLinkage, stageLibs, stageIntoRootfs, setLibs, readLibMap, orphanedLibs, conflictingLibs,
  toolchainLibFor, toolchainMirrorLib, type LibDep,
} from '@aura/core';

/**
 * Capability install/remove, server-side.
 *
 * Why this endpoint exists at all: `aura cap install` is most often invoked
 * from inside the Terminal app — which lives in a PRoot. Two things break in
 * that context:
 *   1. apt-key/gnupg aren't in the base-rootfs → GPG verification fails on
 *      `apt-get update`.
 *   2. `/os/toolchain/bin` isn't bind-mounted into the proot, so the
 *      capability symlink can't be created from there.
 * Routing the work through the shell process (which runs in the container,
 * outside any proot) makes both go away: apt works against the container's
 * apt cache, and the symlink lands in the toolchain dir that ProotRunner
 * binds into every future proot.
 */

interface CapabilityEntry {
  source: 'apt' | 'npm' | 'curl' | 'builtin';
  package?: string;
  binary?: string;
  binary_path?: string;
  url?: string;
  extract?: 'tar' | 'zip';
  binary_in_archive?: string;
  install_cmd?: string;
  /**
   * Extra files this capability needs beside its main binary. Usually
   * unnecessary — helpers named `<binary>-*` in the tool's own directory are
   * detected automatically (see `detectSidecars`). Declare a name here only
   * when the convention doesn't hold.
   */
  sidecars?: string[];
}

interface State {
  capabilities: Record<string, { installed: boolean; installedAt: string; version: string | null }>;
  services:     Record<string, unknown>;
}

const STATE_PATH    = process.env['AURA_STATE_PATH']    ?? '/data/aura/state/capabilities.json';
const TOOLCHAIN_BIN = join(process.env['AURA_TOOLCHAIN_DIR'] ?? '/os/toolchain', 'bin');
// Mirror of the toolchain inside the aura-app-data named volume. Container-
// sandbox apps mount this via --mount volume-subpath because they can't see
// /os/toolchain (it only lives inside the aura-shell image). Keep both in
// sync so wildcard-cap apps and explicit-grant apps see the same set of tools
// regardless of which sandbox they run in.
const TOOLCHAIN_BIN_MIRROR = join(process.env['AURA_DATA_DIR'] ?? '/data', 'aura', 'toolchain', 'bin');

function sh(cmd: string): string {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}
function which(name: string): string | null {
  try { return sh(`which ${name}`); } catch { return null; }
}
function installBinary(src: string, dst: string): void {
  // Copy, don't symlink. PRoot's --bind on a symlink fails with EINVAL on
  // readlink (the ptrace translation can't follow bind-target symlinks),
  // which manifests as "command not found" inside proots even when the
  // binary clearly exists on the container. Real-file installs sidestep
  // the chained-resolution path entirely — every proot sees a plain file
  // in /aura/all-tools that translates one-hop to the store on the host.
  //
  // Always writes a second copy into the named-volume mirror so the cap is
  // visible to sibling-container apps too (they can't bind /os/toolchain).
  // See cap.ts header comment on TOOLCHAIN_BIN_MIRROR for the why.
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
    try { if (lstatSync(target).isSymbolicLink()) unlinkSync(target); } catch { /* not present */ }
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
  entry: CapabilityEntry,
  baseRootfs: string,
): { libsCopied: number; libs: LibDep[]; sidecars: string[] } {
  installBinary(src, join(TOOLCHAIN_BIN, binaryName));

  const found = detectSidecars({ binaryPath: src, binaryName, declared: entry.sidecars });
  for (const sc of found) installBinary(sc.src, join(TOOLCHAIN_BIN, sc.name));

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

async function installCapability(name: string, entry: CapabilityEntry): Promise<{ symlink: string; version: string | null; libsCopied: number; libs: LibDep[]; sidecars: string[] }> {
  const binaryName = entry.binary ?? name;
  const link = join(TOOLCHAIN_BIN, binaryName);
  const baseRootfs = process.env['AURA_BASE_ROOTFS'] ?? '/os/base-rootfs';

  switch (entry.source) {
    case 'builtin': {
      if (!entry.binary_path || !existsSync(entry.binary_path)) {
        return { symlink: link, version: null, libsCopied: 0, libs: [], sidecars: [] };
      }
      const res = installWithSidecars(entry.binary_path, binaryName, entry, baseRootfs);
      return { symlink: link, version: null, ...res };
    }
    case 'apt': {
      if (!entry.package) throw new Error(`apt source requires 'package'`);
      sh(`apt-get update -qq && apt-get install -y -q ${entry.package}`);
      const found = which(binaryName);
      if (!found) throw new Error(`apt install succeeded but binary '${binaryName}' not on PATH`);
      const res = installWithSidecars(found, binaryName, entry, baseRootfs);
      let version: string | null = null;
      try { version = sh(`dpkg-query -W -f='\${Version}' ${entry.package}`); } catch { /* ignore */ }
      return { symlink: link, version, ...res };
    }
    case 'npm': {
      if (!entry.package) throw new Error(`npm source requires 'package'`);
      sh(`npm install -g ${entry.package}`);
      // Prefer an explicit binary_path: some packages (e.g. @openai/codex)
      // expose a JS launcher as their bin that only works from inside the
      // package tree, while the real executable lives in a platform dep.
      const found = entry.binary_path && existsSync(entry.binary_path) ? entry.binary_path : which(binaryName);
      if (!found) throw new Error(`npm install succeeded but binary '${binaryName}' not on PATH`);
      const res = installWithSidecars(found, binaryName, entry, baseRootfs);
      let version: string | null = null;
      try { version = sh(`npm view ${entry.package} version`); } catch { /* ignore */ }
      return { symlink: link, version, ...res };
    }
    case 'curl': {
      if (!entry.install_cmd) throw new Error(`curl source requires 'install_cmd' (extract-from-archive not yet supported server-side)`);
      sh(entry.install_cmd);
      const binPath = entry.binary_path && existsSync(entry.binary_path) ? entry.binary_path : which(binaryName);
      if (!binPath) throw new Error(`curl install for ${name} finished but binary missing`);
      const res = installWithSidecars(binPath, binaryName, entry, baseRootfs);
      return { symlink: link, version: null, ...res };
    }
  }
}

async function removeCapability(name: string, entry: CapabilityEntry): Promise<void> {
  const binaryName = entry.binary ?? name;
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
  if (entry.source === 'apt' && entry.package) {
    try { sh(`apt-get remove -y -q ${entry.package}`); } catch { /* ignore */ }
  } else if (entry.source === 'npm' && entry.package) {
    try { sh(`npm uninstall -g ${entry.package}`); } catch { /* ignore */ }
  }
}

export const GET: APIRoute = () => {
  const state = loadState();
  return new Response(JSON.stringify({ statePath: STATE_PATH, state }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request }) => {
  let body: { name?: string; action?: 'install' | 'remove'; entry?: CapabilityEntry };
  try { body = await request.json(); } catch { body = {}; }
  const action = body.action ?? 'install';
  const name   = body.name;
  const entry  = body.entry;
  if (!name)  return new Response(JSON.stringify({ error: '`name` required' }), { status: 400 });
  if (!entry) return new Response(JSON.stringify({ error: '`entry` required (CLI sends the parsed registry entry to avoid duplicating the YAML parser server-side)' }), { status: 400 });

  const state = loadState();
  try {
    if (action === 'remove') {
      await removeCapability(name, entry);
      delete state.capabilities[name];
      saveState(state);
      return new Response(JSON.stringify({ ok: true, action, name }), { status: 200 });
    }
    const result = await installCapability(name, entry);
    state.capabilities[name] = { installed: true, installedAt: new Date().toISOString(), version: result.version };
    saveState(state);
    const mgr = getAppManager();
    // Push the freshly installed binary into the toolchain mirror BEFORE
    // refreshing any allowlist. Allowlist entries are hardlinks FROM the
    // mirror, so a refresh that runs first would find nothing to link and
    // provision the new cap as missing.
    mgr.syncToolchainMirror();
    // Hot-refresh every running app whose effective tool set tracks what's
    // installed (`'*'` and `'#'`) so its /aura/my-tools allowlist picks the
    // new binary up without a respawn. Explicit-list apps don't get the new
    // cap until someone runs `aura cap grant <appId> <name>`.
    const refreshed = mgr.refreshWildcardApps();
    return new Response(JSON.stringify({
      ok: true, action, name,
      symlink: result.symlink,
      version: result.version,
      libsCopied: result.libsCopied,
      // Named, not just counted: the CLI reports these the way it already
      // reports sidecars, so a multi-file install is visible rather than
      // implied. `libsMissing` is the loud case — installed but unrunnable.
      libs: result.libs.filter((d) => d.kind === 'staged').map((d) => d.soname),
      libsMissing: result.libs.filter((d) => d.kind === 'missing').map((d) => d.soname),
      sidecars: result.sidecars,
      refreshed,
    }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
