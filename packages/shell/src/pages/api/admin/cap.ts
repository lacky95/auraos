import type { APIRoute } from 'astro';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, lstatSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { getAppManager } from '@aura/core';

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
    try {
      const st = lstatSync(target);
      if (st.isSymbolicLink() || st.isFile()) unlinkSync(target);
    } catch { /* not present */ }
    copyFileSync(src, target);
    try { chmodSync(target, 0o755); } catch { /* best effort */ }
  }
}

/**
 * Walk the binary's dynamic-library dependency graph via ldd and copy every
 * shared object into the matching path inside the proot's base-rootfs.
 *
 * Why this is necessary: `apt-get install` runs in the CONTAINER, so libs
 * land in `/usr/lib/x86_64-linux-gnu/` on the container. The proot's `/` is
 * `/os/base-rootfs` — a SNAPSHOT of the container at image-build time. New
 * apt-installed libs never make it across. Without this copy, an
 * apt-installed binary is found on PATH inside the proot but exits with
 * "libfoo.so.N: cannot open shared object file: No such file or directory"
 * on the first dynamic link lookup.
 *
 * ldd already resolves transitively — one pass copies the whole graph.
 * `copyFileSync` dereferences symlinks, so the destination is always a
 * regular file (matters for PRoot, which has the readlink quirk on
 * bound symlinks — see installBinary above).
 *
 * Returns the list of libs that were newly added to base-rootfs.
 */
function copyLibraryDeps(binary: string, baseRootfs: string): string[] {
  const added: string[] = [];
  let lddOut: string;
  try { lddOut = sh(`ldd ${binary}`); } catch { return added; }
  for (const line of lddOut.split('\n')) {
    // ldd's "lib.so => /path/to/lib.so (0xaddress)" — capture the path. The
    // "linux-vdso.so.1 (0x...)" and "ld-linux-x86-64.so.2 (0x...)" lines
    // either have no `=>` or already point at base-rootfs paths; skip both.
    const m = line.match(/=>\s+(\/\S+)\s/);
    if (!m) continue;
    const libPath = m[1]!;
    if (libPath === 'not' || !existsSync(libPath)) continue; // "not found"
    const dstLib = join(baseRootfs, libPath);
    if (existsSync(dstLib)) continue;
    try {
      mkdirSync(dirname(dstLib), { recursive: true });
      copyFileSync(libPath, dstLib);
      added.push(libPath);
    } catch (err) {
      console.warn(`[cap-install] could not stage lib ${libPath} → ${dstLib}: ${(err as Error).message}`);
    }
  }
  return added;
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

async function installCapability(name: string, entry: CapabilityEntry): Promise<{ symlink: string; version: string | null; libsCopied: number }> {
  const binaryName = entry.binary ?? name;
  const link = join(TOOLCHAIN_BIN, binaryName);
  const baseRootfs = process.env['AURA_BASE_ROOTFS'] ?? '/os/base-rootfs';
  let libsCopied = 0;

  switch (entry.source) {
    case 'builtin': {
      if (entry.binary_path && existsSync(entry.binary_path)) {
        installBinary(entry.binary_path, link);
        libsCopied = copyLibraryDeps(entry.binary_path, baseRootfs).length;
      }
      return { symlink: link, version: null, libsCopied };
    }
    case 'apt': {
      if (!entry.package) throw new Error(`apt source requires 'package'`);
      sh(`apt-get update -qq && apt-get install -y -q ${entry.package}`);
      const found = which(binaryName);
      if (!found) throw new Error(`apt install succeeded but binary '${binaryName}' not on PATH`);
      installBinary(found, link);
      libsCopied = copyLibraryDeps(found, baseRootfs).length;
      let version: string | null = null;
      try { version = sh(`dpkg-query -W -f='\${Version}' ${entry.package}`); } catch { /* ignore */ }
      return { symlink: link, version, libsCopied };
    }
    case 'npm': {
      if (!entry.package) throw new Error(`npm source requires 'package'`);
      sh(`npm install -g ${entry.package}`);
      const found = which(binaryName);
      if (!found) throw new Error(`npm install succeeded but binary '${binaryName}' not on PATH`);
      installBinary(found, link);
      libsCopied = copyLibraryDeps(found, baseRootfs).length;
      let version: string | null = null;
      try { version = sh(`npm view ${entry.package} version`); } catch { /* ignore */ }
      return { symlink: link, version, libsCopied };
    }
    case 'curl': {
      if (!entry.install_cmd) throw new Error(`curl source requires 'install_cmd' (extract-from-archive not yet supported server-side)`);
      sh(entry.install_cmd);
      const binPath = entry.binary_path && existsSync(entry.binary_path) ? entry.binary_path : which(binaryName);
      if (!binPath) throw new Error(`curl install for ${name} finished but binary missing`);
      installBinary(binPath, link);
      libsCopied = copyLibraryDeps(binPath, baseRootfs).length;
      return { symlink: link, version: null, libsCopied };
    }
  }
}

async function removeCapability(name: string, entry: CapabilityEntry): Promise<void> {
  const binaryName = entry.binary ?? name;
  for (const link of [join(TOOLCHAIN_BIN, binaryName), join(TOOLCHAIN_BIN_MIRROR, binaryName)]) {
    try { unlinkSync(link); } catch { /* not present */ }
  }
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
    return new Response(JSON.stringify({ ok: true, action, name, symlink: result.symlink, version: result.version, libsCopied: result.libsCopied, refreshed }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
