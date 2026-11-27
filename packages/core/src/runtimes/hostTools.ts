/**
 * The `tools` group of the built-in runtimes (D100 §5): today's provisioning
 * of `/aura/my-tools` as a host directory per instance (A4: only runtimes with
 * `hostFilesystem`), reported as an operation result. The provider confirms
 * what it applied; the legacy symlink mode makes the grant advisory (every
 * tool reachable by absolute path) and is reported as such, never as an
 * enforced boundary (D100 owner decision 1; removed in Phase 6 B).
 */
import { existsSync, lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SandboxRunner } from '../app-manager/SandboxRunner.js';
import type { ToolsMode } from '../app-manager/tool-provision.js';
import { operationResult, type RuntimeFeatureOverrides, type RuntimeToolEntry, type RuntimeTools, type RuntimeToolsStatus } from './ari.js';
import type { RuntimeCapabilities } from './types.js';

export type { ToolsMode };

/** What the grant is on this host: `enforced` (hardlink mirror) or `advisory` (legacy symlink mode). */
export function toolsEnforcement(mode: ToolsMode): 'enforced' | 'advisory' {
  return mode === 'hardlink' ? 'enforced' : 'advisory';
}

/**
 * The toolchain store an allowlist dir is provisioned from (tool-provision,
 * tool-libs), handed in by the composition point: the mirror's bin dir, the
 * libraries a tool needs staged, and the name of an instance's library dir.
 */
export interface HostToolStore {
  mirrorBin: string;
  neededLibs(tool: string): string[];
  libDirName: string;
}

/**
 * An allowlist dir as provisioned (`tools.status`): entries are hardlinks in
 * the default mode and symlinks in legacy mode, so both shapes are described:
 * `kind` says which, `target` is set for symlinks only, and `resolves`
 * reports whether the entry leads to a binary whose libraries are there.
 */
export function describeToolsDir(dir: string, store: HostToolStore | null): RuntimeToolsStatus {
  if (!existsSync(dir)) return { provisioned: false, entries: [], libs: null };
  // Dotfiles are not tools: `.lib` is the granted libraries' dir, and
  // reporting it as an entry would both inflate the entry count (which the
  // grant picker reads) and classify a directory as kind:'unknown' — a
  // broken-looking tool that isn't one.
  const entries = readdirSync(dir).filter((n) => !n.startsWith('.')).map((name): RuntimeToolEntry => {
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
        resolves = !!store && existsSync(join(store.mirrorBin, name));
      } else if (st.isFile()) {
        // Hardlink: nlink > 1 means the mirror still references it too.
        kind = st.nlink > 1 ? 'hardlink' : 'file';
        resolves = st.size > 0;
      }
    } catch { /* raced with a refresh */ }
    // `resolves` used to mean only "the file is there", which is exactly
    // the blind spot that let a cap whose shared libraries were missing
    // report healthy right up until someone ran it.
    const needed = store?.neededLibs(name) ?? [];
    const missing = store ? needed.filter((so) => !existsSync(join(dir, store.libDirName, so))) : [];
    return { name, kind, target, resolves: resolves && missing.length === 0, libs: { needed: needed.length, missing } };
  });
  const libDir = store ? join(dir, store.libDirName) : null;
  return { provisioned: true, entries, libs: libDir && existsSync(libDir) ? readdirSync(libDir).sort() : null };
}

/**
 * The `tools` group over a runner's allowlist dir. `mode` reads the host's
 * tools mode (null: not known); `store` is the toolchain store (null: status
 * reports no library checks).
 */
export function hostToolsGroup(
  runner: Pick<SandboxRunner, 'provisionToolsDir' | 'toolsDir'>, mode: () => ToolsMode | null, store: () => HostToolStore | null = () => null,
): RuntimeTools {
  return {
    status: (instanceId) => describeToolsDir(runner.toolsDir(instanceId), store()),
    apply(instanceId, set) {
      const target = { instanceId };
      try {
        runner.provisionToolsDir(instanceId, { tools: set.tools });
      } catch (err) {
        return operationResult('tools.liveGrant', target, 'failed', { error: { code: 'provisioning-failed', message: (err as Error).message } });
      }
      const m = mode();
      return operationResult('tools.liveGrant', target, 'applied', { detail: m ? { mode: m, enforcement: toolsEnforcement(m) } : {} });
    },
  };
}

/** Symlink mode: the tool features stay usable but `conditional`, with `enforcement: advisory`. Never upgrades an unsupported one. */
export function toolsFeatureOverrides(caps: RuntimeCapabilities, mode: ToolsMode | null): RuntimeFeatureOverrides {
  if (mode !== 'symlink' || !caps.hostFilesystem) return {};
  const advisory = { support: 'conditional' as const, constraints: { enforcement: 'advisory' } };
  return {
    'tools.provision': advisory, 'tools.liveGrant': advisory, 'tools.liveRevoke': advisory,
    ...(caps.sidecars ? { 'tools.inheritance': advisory } : {}),
  };
}
