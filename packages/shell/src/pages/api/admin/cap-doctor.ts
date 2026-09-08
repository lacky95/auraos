import type { APIRoute } from 'astro';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  getAppManager, listToolchainBinaries, readSidecarMap, sidecarNames,
  readLibMap, readLinkage, stageLibs, stageIntoRootfs, setLibs, restoreLibsFromStore,
  toolchainMirrorBin, toolchainMirrorLib, toolchainLibFor,
  type LibDep, type Linkage,
} from '@aura/core';

/**
 * `aura cap doctor` — does every installed capability actually RUN in the
 * sandboxes it can be granted to?
 *
 * Why a server route: the CLI is normally invoked from inside the Terminal
 * app, where /os, the toolchain and the docker socket are all invisible. The
 * shell is the only process that can see all three, exactly as with
 * /api/admin/cap.
 *
 * Why it exists at all: a capability that installs cleanly and then dies at
 * exec ("cannot open shared object file") is indistinguishable from a healthy
 * one by every other check we have — `cap list` says installed, `inspect-tools`
 * says the hardlink resolves. This route resolves each cap's dependency graph
 * per sandbox and turns that silent failure into a visible one.
 */

const TOOLCHAIN_BIN = join(process.env['AURA_TOOLCHAIN_DIR'] ?? '/os/toolchain', 'bin');
const BASE_ROOTFS   = process.env['AURA_BASE_ROOTFS'] ?? '/os/base-rootfs';
const BASE_IMAGE    = process.env['AURA_BASE_IMAGE'] ?? 'aura-base';
const APP_DATA_VOLUME = process.env['AURA_APP_DATA_VOLUME'] ?? 'aura_aura-app-data';

/** Standard lib dirs to look in when checking a rootfs by hand. */
const ROOTFS_LIB_DIRS = [
  'lib/x86_64-linux-gnu', 'usr/lib/x86_64-linux-gnu', 'lib64', 'usr/lib', 'lib',
];

/**
 * The probe script, run inside each sandbox. Emits `@@ <binary>` then one line
 * per unresolvable library, so one short-lived sandbox answers for the whole
 * toolchain at once.
 *
 * Passed as a single argv element to execFileSync — never through a shell on
 * THIS side. Interpolating it into a shell string lets the shell expand `$f`
 * and `$(basename …)` before the sandbox ever sees them, which silently turns
 * the probe into a no-op that reports every capability healthy.
 */
const PROBE_SCRIPT =
  'for f in /probe/bin/*; do ' +
  'b=$(basename "$f"); case "$b" in .*) continue;; esac; ' +
  'echo "@@ $b"; ldd "$f" 2>/dev/null | grep "not found"; done; ' +
  // The loop's exit status is the last `grep`'s, and grep exits 1 when it finds
  // nothing — i.e. a HEALTHY toolchain would look like a failed probe.
  'exit 0';

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/** `{ binary: [unresolvable soname, …] }` from a probe's stdout. */
function parseProbe(out: string): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  let cur: string | null = null;
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('@@ ')) { cur = t.slice(3).trim(); found[cur] = []; continue; }
    const soname = t.split('=>')[0]?.trim();
    if (cur && soname) found[cur]?.push(soname);
  }
  return found;
}

export interface CapHealth {
  name: string;
  linkage: Linkage;
  sidecars: string[];
  /** Sonames the tool carries with it. */
  staged: string[];
  /** Sonames nothing can resolve — the tool is broken wherever it runs. */
  unresolved: string[];
  proot: { ok: boolean | null; missing: string[] };
  /**
   * `ok: null` means UNKNOWN, not healthy and not broken. The shell cannot see
   * inside the app image, so without the probe the only honest answer for a
   * library we did not stage is "the image may well have it" — reporting that
   * as a failure would have flagged `bash`, `curl` and `git`, which work fine.
   */
  container: { ok: boolean | null; missing: string[]; observed: boolean };
}

/** Deps for a cap, preferring the recorded map and falling back to a live ldd
 *  so doctor is useful for caps installed BEFORE libraries were tracked. */
function depsFor(bin: string, mirrorBin: string, map: Record<string, LibDep[]>): { linkage: Linkage; deps: LibDep[] } {
  const recorded = map[bin];
  if (recorded && recorded.length) return { linkage: 'dynamic', deps: recorded };
  const store = join(mirrorBin, bin);
  if (!existsSync(store)) return { linkage: 'unreadable', deps: [] };
  return readLinkage(store);
}

function presentInRootfs(soname: string, rootfs: string): boolean {
  return ROOTFS_LIB_DIRS.some((d) => existsSync(join(rootfs, d, soname)));
}

export const GET: APIRoute = async ({ url }) => {
  // The probe is the DEFAULT, not an opt-in: it costs one short-lived container
  // (~0.3s for the whole toolchain) and is the only way to answer the container
  // question truthfully. `?probe=0` is the escape hatch for a host with no
  // docker socket.
  const wantProbe = url.searchParams.get('probe') !== '0';
  const mgr = getAppManager();
  const dataDir   = mgr.getDataDir();
  const mirrorBin = toolchainMirrorBin(dataDir);
  const mirrorLib = toolchainMirrorLib(dataDir);
  // The probe mounts this by volume-subpath, and docker refuses a subpath that
  // doesn't exist yet — so make sure it does before anything tries.
  try { mkdirSync(mirrorLib, { recursive: true }); } catch { /* best effort */ }
  const map       = readLibMap(mirrorBin);
  const sidecars  = readSidecarMap(mirrorBin);
  const helpers   = sidecarNames(sidecars);

  const names = listToolchainBinaries(mirrorBin).filter((n) => !helpers.has(n)).sort();

  // Ground truth, both columns: run the same probe in each sandbox, with the
  // same LD_LIBRARY_PATH an app gets. One short-lived sandbox answers for the
  // whole toolchain (~0.3s each), which is why this is the default rather than
  // an opt-in — modelling the container from here means guessing what the app
  // image ships, and guessing flagged `bash`, `curl` and `git` as broken when
  // they are fine.
  let inContainer: Record<string, string[]> | null = null;
  let inProot: Record<string, string[]> | null = null;
  if (wantProbe) {
    try {
      inContainer = parseProbe(run('docker', [
        'run', '--rm',
        '--mount', `type=volume,source=${APP_DATA_VOLUME},target=/probe/bin,volume-subpath=aura/toolchain/bin,readonly`,
        '--mount', `type=volume,source=${APP_DATA_VOLUME},target=/probe/lib,volume-subpath=aura/toolchain/lib,readonly`,
        '-e', 'LD_LIBRARY_PATH=/probe/lib',
        BASE_IMAGE, 'sh', '-c', PROBE_SCRIPT,
      ]));
    } catch (err) {
      console.warn(`[cap-doctor] container probe unavailable: ${(err as Error).message}`);
    }
    try {
      inProot = parseProbe(run('proot', [
        `--rootfs=${BASE_ROOTFS}`,
        `--bind=${mirrorBin}:/probe/bin`,
        `--bind=${mirrorLib}:/probe/lib`,
        '--cwd=/',
        '/bin/sh', '-c', `LD_LIBRARY_PATH=/probe/lib; export LD_LIBRARY_PATH; ${PROBE_SCRIPT}`,
      ]));
    } catch (err) {
      console.warn(`[cap-doctor] proot probe unavailable: ${(err as Error).message}`);
    }
  }

  const caps: CapHealth[] = names.map((name) => {
    const { linkage, deps } = depsFor(name, mirrorBin, map);
    const staged     = deps.filter((d) => d.kind === 'staged').map((d) => d.soname);
    const unresolved = deps.filter((d) => d.kind === 'missing').map((d) => d.soname);

    // A staged-but-unstored soname is NOT evidence of breakage — the sandbox's
    // own image may ship it (libtinfo for bash, libz for git). Only the probe
    // knows; without it the honest answer is "unknown", except for a dependency
    // ldd could not resolve even here, which is broken everywhere.
    const verdict = (
      probe: Record<string, string[]> | null,
      fallback: () => string[] | null,
    ): { ok: boolean | null; missing: string[] } => {
      const missing = probe ? (probe[name] ?? []) : fallback();
      if (missing === null) return { ok: unresolved.length ? false : null, missing: [] };
      return { ok: missing.length === 0 && unresolved.length === 0, missing };
    };

    return {
      name,
      linkage,
      sidecars: sidecars[name] ?? [],
      staged,
      unresolved,
      // Without the proot probe we can still check by hand: base-rootfs is a
      // plain directory the shell can read.
      proot: verdict(inProot, () => staged.filter(
        (s) => !existsSync(join(mirrorLib, s)) && !presentInRootfs(s, BASE_ROOTFS),
      )),
      container: { ...verdict(inContainer, () => null), observed: inContainer !== null },
    };
  });

  return new Response(JSON.stringify({
    ok: true,
    probed: inContainer !== null && inProot !== null,
    probes: { container: inContainer !== null, proot: inProot !== null },
    mirrorBin, mirrorLib, caps,
  }, null, 2), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

/**
 * `--fix`: re-stage libraries for the named caps (or every unhealthy one).
 *
 * Deliberately does NOT re-run apt/npm — it re-resolves the binary already in
 * the store, so a repair is fast, offline, and safe to run on a whole toolchain.
 * When the origin paths are gone (a container recreate discarded the writable
 * layer), it falls back to restoring them from the volume-backed store.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: { names?: string[]; refreshOnly?: boolean } = {};
  try { body = await request.json() as typeof body; } catch { /* empty body is fine */ }

  const mgr = getAppManager();
  const dataDir   = mgr.getDataDir();
  const mirrorBin = toolchainMirrorBin(dataDir);
  const libDirs   = [toolchainLibFor(TOOLCHAIN_BIN), toolchainMirrorLib(dataDir)] as const;
  const sidecars  = readSidecarMap(mirrorBin);
  const helpers   = sidecarNames(sidecars);

  const all = listToolchainBinaries(mirrorBin).filter((n) => !helpers.has(n));
  // No names = repair everything. The CLI narrows this to the capabilities
  // that actually fail before calling, so the broad form is the deliberate
  // "re-stage the whole toolchain" escape hatch rather than the normal path.
  const targets = body.names?.length ? body.names.filter((n) => all.includes(n)) : all;

  const repaired: Array<{ name: string; staged: string[]; restored: number }> = [];
  // `refreshOnly` skips staging entirely and just re-materialises the running
  // instances. The stores can be perfectly healthy while a live instance
  // predates them — that instance has no `.lib` until something re-provisions
  // it, and nothing else would.
  for (const name of body.refreshOnly ? [] : targets) {
    // Resolve against the store copy: it is the one that survived a recreate,
    // and it is what every instance is actually provisioned from.
    const files = [join(mirrorBin, name), ...(sidecars[name] ?? []).map((h) => join(mirrorBin, h))]
      .filter((f) => existsSync(f));
    if (!files.length) continue;

    const deps = new Map<string, LibDep>();
    for (const f of files) {
      for (const d of readLinkage(f).deps) if (!deps.has(d.soname)) deps.set(d.soname, d);
    }
    const list = [...deps.values()];
    if (!list.length) continue;

    const { staged } = stageLibs(list, libDirs);
    stageIntoRootfs(list, BASE_ROOTFS);
    setLibs([TOOLCHAIN_BIN, mirrorBin], name, list);

    // Anything ldd couldn't resolve here may still be recoverable from the
    // store, if this is a post-recreate shell that lost its /usr/lib copies.
    const restored = restoreLibsFromStore(
      { [name]: list }, toolchainMirrorLib(dataDir), '/',
    ).length;
    repaired.push({ name, staged, restored });
  }

  // Mirror first, THEN refresh: allowlist entries are hardlinks from the
  // mirror, so a refresh that runs first links yesterday's store.
  mgr.syncToolchainMirror();
  const refreshed = mgr.refreshWildcardApps();

  return new Response(JSON.stringify({ ok: true, repaired, refreshed }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};
