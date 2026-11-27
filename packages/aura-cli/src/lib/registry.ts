import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, symlinkSync, unlinkSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import {
  detectSidecars, findBinaryPath, readSidecarMap, setAliases, setSidecars,
  readLinkage, stageLibs, setLibs, readLibMap, orphanedLibs, toolchainLibFor,
} from '@aura/core';
import { api } from './client.js';

/**
 * Capability definitions are the shell's (SF-2): the release tree's
 * `.aura/capabilities.yaml` plus the entries the owner added through
 * `/api/admin/cap-registry`. Installs name a capability; the shell resolves
 * and runs its definition. This file reads the same registry for listings
 * when the shell is unreachable, and the `services:` section for
 * `aura service`. It writes neither (Phase 6 O): the release file is
 * read-only, and the shell generates the effective view (release + the
 * owner's entries) into the overlay `/data/aura/overlay/capabilities.yaml`
 * (`AURA_REGISTRY_OVERLAY`), which containers see at the release path.
 */
export type CapabilitySource = 'apt' | 'npm' | 'steps' | 'builtin';

export interface CapabilityEntry {
  source: CapabilitySource;
  package?: string;
  binary?: string;
  binary_path?: string;
  /** source `steps`: structured install steps the shell runs (core capabilities/definition.ts). */
  steps?: unknown[];
  /**
   * Extra files this capability needs beside its main binary. Usually
   * unnecessary — helpers named `<binary>-*` in the tool's own directory are
   * detected automatically. Declare a name here only when that doesn't hold.
   */
  sidecars?: string[];
  /** Other names `tools[]` may use for this binary (core capabilities/definition.ts). */
  aliases?: string[];
  description?: string;
}

export interface ServiceEntry extends CapabilityEntry {
  port?: number;
  start_cmd?: string;
  default_config?: string;
  config?: string;
}

export interface Registry {
  capabilities: Record<string, CapabilityEntry>;
  services:     Record<string, ServiceEntry>;
}

export interface StateEntry {
  installed: boolean;
  installedAt: string;
  version: string | null;
}

export interface State {
  capabilities: Record<string, StateEntry>;
  services:     Record<string, StateEntry>;
}

const REGISTRY_PATH = process.env['AURA_REGISTRY_PATH'] ?? '/workspace/.aura/capabilities.yaml';
const REGISTRY_OVERLAY = process.env['AURA_REGISTRY_OVERLAY'] ?? '/data/aura/overlay/capabilities.yaml';
const STATE_PATH    = process.env['AURA_STATE_PATH']    ?? '/data/aura/state/capabilities.json';
const TOOLCHAIN_BIN = join(process.env['AURA_TOOLCHAIN_DIR'] ?? '/os/toolchain', 'bin');

function readRegistryFile(path: string): Partial<Registry> | null {
  return existsSync(path) ? parseYaml(readFileSync(path, 'utf-8')) as Partial<Registry> | null : null;
}

/**
 * The registry as this process sees it (read-only; empty when it is not mounted here): the
 * release file, plus the overlay's capabilities it does not define (in the master; in a
 * container the release path already holds the effective view).
 */
export function loadRegistry(): Registry {
  const release = readRegistryFile(REGISTRY_PATH);
  let overlay: Partial<Registry> | null = null;
  // A generated view: a broken one never hides the release's entries.
  try { if (REGISTRY_OVERLAY !== REGISTRY_PATH) overlay = readRegistryFile(REGISTRY_OVERLAY); } catch { /* the release's only */ }
  return {
    capabilities: { ...(overlay?.capabilities ?? {}), ...(release?.capabilities ?? {}) },
    services:     release?.services ?? overlay?.services ?? {},
  };
}

export interface ResolvedEntry { definition: CapabilityEntry; origin: 'release' | 'owner'; digest: string }

/** The capabilities the shell installs (release + the owner's), or the local file's when the shell is unreachable. */
export async function fetchCapabilities(): Promise<Record<string, CapabilityEntry>> {
  try {
    const r = await api.get<{ registry?: Record<string, ResolvedEntry> }>('/api/admin/cap');
    if (r.registry) return Object.fromEntries(Object.entries(r.registry).map(([n, e]) => [n, e.definition]));
  } catch { /* fall back to the file */ }
  return loadRegistry().capabilities;
}

export function loadState(): State {
  if (!existsSync(STATE_PATH)) return { capabilities: {}, services: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as Partial<State>;
    return { capabilities: parsed.capabilities ?? {}, services: parsed.services ?? {} };
  } catch {
    return { capabilities: {}, services: {} };
  }
}

export function saveState(state: State): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  // Write beside, then rename (the shell's capabilityInstall.ts does the same):
  // an interrupted write never leaves a truncated state file.
  const tmp = `${STATE_PATH}.aura-new-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH);
}

function sh(cmd: string): string {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
}

function which(name: string): string | null {
  try { return sh(`which ${name}`); } catch { return null; }
}

function ensureSymlink(target: string, link: string): void {
  mkdirSync(dirname(link), { recursive: true });
  try {
    const st = lstatSync(link);
    if (st.isSymbolicLink() || st.isFile()) unlinkSync(link);
  } catch { /* not present */ }
  symlinkSync(target, link);
}

export interface InstallResult {
  symlink: string;
  version: string | null;
  /** Helper binaries linked alongside the main one. */
  sidecars?: string[];
}

/**
 * Link the main binary AND every file that has to travel with it, then record
 * the relationship so `tools[]` grants them as a unit. Mirrors the shell's
 * `installWithSidecars`; see @aura/core's `detectSidecars` for the rule.
 */
function linkWithSidecars(src: string, binaryName: string, entry: CapabilityEntry): string[] {
  ensureSymlink(src, join(TOOLCHAIN_BIN, binaryName));
  const found = detectSidecars({ binaryPath: src, binaryName, declared: entry.sidecars });
  for (const sc of found) ensureSymlink(sc.src, join(TOOLCHAIN_BIN, sc.name));
  setSidecars([TOOLCHAIN_BIN], binaryName, found.map((sc) => sc.name));
  setAliases([TOOLCHAIN_BIN], binaryName, entry.aliases ?? []);

  // Record and stage the shared libraries too. This path is the DEGRADED
  // fallback (see the header comment on why installs normally route through
  // the shell) — it can't reach the volume mirror or base-rootfs, so it does
  // the part it can: a local lib store plus the `.libs.json` entry, without
  // which `aura cap doctor` cannot see this capability at all.
  const deps = new Map<string, ReturnType<typeof readLinkage>['deps'][number]>();
  for (const file of [src, ...found.map((sc) => sc.src)]) {
    for (const dep of readLinkage(file).deps) if (!deps.has(dep.soname)) deps.set(dep.soname, dep);
  }
  const libs = [...deps.values()];
  stageLibs(libs, [toolchainLibFor(TOOLCHAIN_BIN)]);
  setLibs([TOOLCHAIN_BIN], binaryName, libs);

  return found.map((sc) => sc.name);
}

export async function installCapability(name: string, entry: CapabilityEntry): Promise<InstallResult> {
  const binaryName = entry.binary ?? name;
  const link = join(TOOLCHAIN_BIN, binaryName);

  switch (entry.source) {
    case 'builtin': {
      const found = findBinaryPath(entry.binary_path);
      const sidecars = found ? linkWithSidecars(found, binaryName, entry) : [];
      return { symlink: link, version: null, sidecars };
    }
    case 'apt': {
      if (!entry.package) throw new Error(`Registry entry ${name}: apt source requires 'package'`);
      sh(`apt-get update -qq && apt-get install -y -q ${entry.package}`);
      const found = which(binaryName);
      if (!found) throw new Error(`apt install succeeded but binary '${binaryName}' not found on PATH`);
      const sidecars = linkWithSidecars(found, binaryName, entry);
      let version: string | null = null;
      try { version = sh(`dpkg-query -W -f='\${Version}' ${entry.package}`); } catch { /* ignore */ }
      return { symlink: link, version, sidecars };
    }
    case 'npm': {
      if (!entry.package) throw new Error(`Registry entry ${name}: npm source requires 'package'`);
      sh(`npm install -g ${entry.package}`);
      // Prefer an explicit binary_path (see the shell's /api/admin/cap for why).
      const found = findBinaryPath(entry.binary_path) ?? which(binaryName);
      if (!found) throw new Error(`npm install succeeded but binary '${binaryName}' not found on PATH`);
      const sidecars = linkWithSidecars(found, binaryName, entry);
      let version: string | null = null;
      try { version = sh(`npm view ${entry.package} version`); } catch { /* ignore */ }
      return { symlink: link, version, sidecars };
    }
    default:
      throw new Error(`Unknown source type for ${name}: ${entry.source}`);
  }
}

export async function removeCapability(name: string, entry: CapabilityEntry): Promise<void> {
  const binaryName = entry.binary ?? name;
  // Helpers go with the owner — an orphan would keep appearing in wildcard
  // grants long after the tool was removed.
  for (const bin of [binaryName, ...(readSidecarMap(TOOLCHAIN_BIN)[binaryName] ?? [])]) {
    try { unlinkSync(join(TOOLCHAIN_BIN, bin)); } catch { /* not present */ }
  }
  // Libraries no other capability still references go with it.
  for (const soname of orphanedLibs(readLibMap(TOOLCHAIN_BIN), binaryName)) {
    try { unlinkSync(join(toolchainLibFor(TOOLCHAIN_BIN), soname)); } catch { /* not present */ }
  }
  setLibs([TOOLCHAIN_BIN], binaryName, []);
  setSidecars([TOOLCHAIN_BIN], binaryName, []);
  setAliases([TOOLCHAIN_BIN], binaryName, []);

  if (entry.source === 'apt' && entry.package) {
    try { sh(`apt-get remove -y -q ${entry.package}`); } catch { /* ignore */ }
  } else if (entry.source === 'npm' && entry.package) {
    try { sh(`npm uninstall -g ${entry.package}`); } catch { /* ignore */ }
  }
}
