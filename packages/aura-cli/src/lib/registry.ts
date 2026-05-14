import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
// @ts-expect-error  bundled-as-text by esbuild (loader: { '.yaml': 'text' })
import REGISTRY_DEFAULTS_YAML from '../registry-defaults.yaml';

export type CapabilitySource = 'apt' | 'npm' | 'curl' | 'builtin';

export interface CapabilityEntry {
  source: CapabilitySource;
  package?: string;
  binary?: string;
  binary_path?: string;
  url?: string;
  extract?: 'tar' | 'zip';
  binary_in_archive?: string;
  install_cmd?: string;
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
const STATE_PATH    = process.env['AURA_STATE_PATH']    ?? '/data/aura/state/capabilities.json';
const TOOLCHAIN_BIN = join(process.env['AURA_TOOLCHAIN_DIR'] ?? '/os/toolchain', 'bin');

export function ensureRegistry(): void {
  if (existsSync(REGISTRY_PATH)) return;
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(REGISTRY_PATH, REGISTRY_DEFAULTS_YAML as unknown as string);
}

export function loadRegistry(): Registry {
  if (!existsSync(REGISTRY_PATH)) ensureRegistry();
  const text = readFileSync(REGISTRY_PATH, 'utf-8');
  const parsed = parseYaml(text) as Partial<Registry> | null;
  return {
    capabilities: parsed?.capabilities ?? {},
    services:     parsed?.services ?? {},
  };
}

export function saveRegistry(reg: Registry): void {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(REGISTRY_PATH, stringifyYaml(reg));
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
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
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
}

export async function installCapability(name: string, entry: CapabilityEntry): Promise<InstallResult> {
  const binaryName = entry.binary ?? name;
  const link = join(TOOLCHAIN_BIN, binaryName);

  switch (entry.source) {
    case 'builtin': {
      if (entry.binary_path && existsSync(entry.binary_path)) ensureSymlink(entry.binary_path, link);
      return { symlink: link, version: null };
    }
    case 'apt': {
      if (!entry.package) throw new Error(`Registry entry ${name}: apt source requires 'package'`);
      sh(`apt-get update -qq && apt-get install -y -q ${entry.package}`);
      const found = which(binaryName);
      if (!found) throw new Error(`apt install succeeded but binary '${binaryName}' not found on PATH`);
      ensureSymlink(found, link);
      let version: string | null = null;
      try { version = sh(`dpkg-query -W -f='\${Version}' ${entry.package}`); } catch { /* ignore */ }
      return { symlink: link, version };
    }
    case 'npm': {
      if (!entry.package) throw new Error(`Registry entry ${name}: npm source requires 'package'`);
      sh(`npm install -g ${entry.package}`);
      const found = which(binaryName);
      if (!found) throw new Error(`npm install succeeded but binary '${binaryName}' not found on PATH`);
      ensureSymlink(found, link);
      let version: string | null = null;
      try { version = sh(`npm view ${entry.package} version`); } catch { /* ignore */ }
      return { symlink: link, version };
    }
    case 'curl': {
      if (entry.install_cmd) {
        sh(entry.install_cmd);
        const binPath = entry.binary_path && existsSync(entry.binary_path) ? entry.binary_path : which(binaryName);
        if (!binPath) throw new Error(`curl install for ${name} finished but binary missing (set binary_path in registry)`);
        ensureSymlink(binPath, link);
        return { symlink: link, version: null };
      }
      if (entry.url) {
        const tmp = `/tmp/aura-cap-${name}-${Date.now()}`;
        mkdirSync(tmp, { recursive: true });
        const archive = join(tmp, 'archive');
        sh(`curl -fsSL -o ${archive} '${entry.url}'`);
        if (entry.extract === 'tar') sh(`tar -xf ${archive} -C ${tmp}`);
        else if (entry.extract === 'zip') sh(`unzip -q ${archive} -d ${tmp}`);
        else sh(`install -m 0755 ${archive} ${link}`); // raw binary
        if (entry.binary_in_archive) {
          const extracted = join(tmp, entry.binary_in_archive);
          if (!existsSync(extracted)) throw new Error(`Expected ${extracted} after extracting`);
          sh(`install -m 0755 ${extracted} ${link}`);
        }
        return { symlink: link, version: null };
      }
      throw new Error(`Registry entry ${name}: curl source needs either 'install_cmd' or 'url'`);
    }
    default:
      throw new Error(`Unknown source type for ${name}: ${entry.source}`);
  }
}

export async function removeCapability(name: string, entry: CapabilityEntry): Promise<void> {
  const binaryName = entry.binary ?? name;
  const link = join(TOOLCHAIN_BIN, binaryName);
  try { unlinkSync(link); } catch { /* not present */ }

  if (entry.source === 'apt' && entry.package) {
    try { sh(`apt-get remove -y -q ${entry.package}`); } catch { /* ignore */ }
  } else if (entry.source === 'npm' && entry.package) {
    try { sh(`npm uninstall -g ${entry.package}`); } catch { /* ignore */ }
  }
}
