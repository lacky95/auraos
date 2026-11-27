/**
 * What a scaffold payload may contain (AF1, L5): `/api/admin/scaffold` writes
 * client-supplied files into a new app directory and installs its
 * dependencies in the shell. Nothing in that payload may become code the
 * shell runs, so the files that steer an install or a git command are
 * refused here, before anything is written:
 *
 *   • `.git` entries        the shell makes the repository itself (initRepo);
 *                           a client config (core.fsmonitor, core.hooksPath)
 *                           or hook would run in the shell's own git calls
 *   • `node_modules`        dependencies are installed, never sent
 *   • a pnpmfile            code pnpm loads during the install
 *   • `pnpm-workspace.yaml` pnpm reads install settings from it
 *   • an `.npmrc` other than AURA_NPMRC (it can re-enable scripts or change
 *     the registry); the CLI sends exactly AURA_NPMRC for user/global apps
 *   • in `package.json`: package-manager switches (`packageManager`,
 *     `devEngines`, `pnpm`), dependencies that are not registry packages
 *     (`file:`, `link:`, git, URLs) and malformed `@aura/*` entries
 *     (`aura sdk install` turns them into paths and registry refs)
 *
 * The install itself runs with SCAFFOLD_INSTALL_ARGS (no lifecycle scripts,
 * no pnpmfile) and as an unprivileged uid (app-manager/unprivilegedInstall.ts).
 * The template `aura dev new` renders passes all of this unchanged.
 *
 * A store app (Nexus install, update, patch activation) is checked by
 * refusedStoreInstallFiles: the shell installs its dependencies with npm, from
 * package.json, package-lock.json and .npmrc only, so those are the inputs
 * that may not steer it.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AURA_NPMRC } from './portability.js';

export interface ScaffoldPayloadFile { relPath: string; content: string; mode?: number }
/** One refused file (or package.json entry) and why, for the D105 `refused-file` body. */
export interface ScaffoldFileRefusal { file: string; reason: string }

/** pnpm's install flags for a scaffold: never a lifecycle script, never a pnpmfile. */
export const SCAFFOLD_INSTALL_ARGS: readonly string[] = ['install', '--prefer-offline', '--ignore-scripts', '--ignore-pnpmfile'];

const PNPMFILE = /^\.?pnpmfile\.[cm]?js$/;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'auraDependencies'] as const;
const PACKAGE_MANAGER_FIELDS = ['packageManager', 'devEngines', 'pnpm'] as const;
/** Specs that are not a registry package: a local path, a git repo, a URL, a `user/repo` shorthand. */
const NOT_REGISTRY = /^(file|link|portal|git|git\+[a-z]+|github|gitlab|bitbucket|gist|https?):|^[^@\s:][^\s:]*\/[^\s]+$/i;
const AURA_NAME = /^@aura\/[a-z0-9][a-z0-9._-]*$/;
const AURA_SPEC = /^(workspace:.*|[~^]?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/;

/** The file mode a scaffold writes: 0755 when the client asked for any execute bit, else 0644. */
export function scaffoldFileMode(mode?: number): 0o755 | 0o644 {
  return typeof mode === 'number' && (mode & 0o111) !== 0 ? 0o755 : 0o644;
}

/** Every file of `files` a scaffold refuses, with the reason (empty: the payload is acceptable). */
export function refusedScaffoldFiles(files: readonly ScaffoldPayloadFile[]): ScaffoldFileRefusal[] {
  const out: ScaffoldFileRefusal[] = [];
  for (const f of files) {
    const parts = f.relPath.split('/').filter((p) => p !== '' && p !== '.');
    const name = parts[parts.length - 1] ?? '';
    const refuse = (reason: string) => out.push({ file: f.relPath, reason });
    if (parts.includes('.git')) refuse('the shell creates the git repository itself; a client .git entry (config, hooks) would run in the shell');
    else if (parts.includes('node_modules')) refuse('dependencies are installed by the shell, not sent in the payload');
    else if (PNPMFILE.test(name)) refuse('a pnpmfile is code pnpm runs during the install');
    else if (name === 'pnpm-workspace.yaml') refuse('pnpm reads install settings (hooks, registries, builds) from it');
    else if (name === '.npmrc' && !(parts.length === 1 && f.content === AURA_NPMRC)) {
      refuse('only the AuraOS .npmrc is accepted: an .npmrc can re-enable install scripts or change the registry');
    } else if (parts.length === 1 && name === 'package.json') out.push(...refusedPackageJson(f.content));
  }
  return out;
}

/** The registry a lockfile may resolve from (npm maps it onto the configured registry, replace-registry-host). */
const LOCK_REGISTRY = 'https://registry.npmjs.org/';

/** The settings of an .npmrc: its lines without comments and blanks. */
function npmrcSettings(content: string): string[] {
  return content.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith(';'));
}

/**
 * The inputs of a store app's dependency install the shell refuses (Nexus,
 * owner 2026-11-27: "without allowing untrusted scripts to execute as root").
 * The shell installs from package.json, package-lock.json and .npmrc alone
 * (app-manager/unprivilegedInstall.ts installStoreDepsUnprivileged), so:
 *   • .npmrc: only AURA_NPMRC's settings (its comments may differ); any other
 *     setting can change the registry, re-enable scripts or name a binary npm runs
 *   • package.json: dependencies that are not registry packages, malformed
 *     `@aura/*` entries (as for a scaffold; package-manager fields stay: npm
 *     does not read `pnpm`, and the app's sandbox installs with its own choice)
 *   • package-lock.json: links and entries resolved from anywhere but the registry
 *   • a symlink in place of one of these files
 * pnpm-workspace.yaml and a pnpmfile are pnpm's: the shell never runs pnpm on
 * a store app, only the app's own sandbox does.
 */
export function refusedStoreInstallFiles(appDir: string): ScaffoldFileRefusal[] {
  const out: ScaffoldFileRefusal[] = [];
  const read = (name: string): string | null => {
    const p = join(appDir, name);
    if (!existsSync(p) && !isLink(p)) return null;
    if (!lstatSync(p).isFile()) { out.push({ file: name, reason: 'not a regular file (a symlink or directory)' }); return null; }
    return readFileSync(p, 'utf-8');
  };
  const npmrc = read('.npmrc');
  if (npmrc !== null) {
    const allowed = new Set(npmrcSettings(AURA_NPMRC));
    const foreign = npmrcSettings(npmrc).filter((l) => !allowed.has(l));
    if (foreign.length) {
      out.push({ file: '.npmrc', reason: `only the AuraOS .npmrc is accepted; refused setting${foreign.length > 1 ? 's' : ''}: ${foreign.map((l) => l.split('=')[0]!.trim()).join(', ').slice(0, 200)}` });
    }
  }
  const pkg = read('package.json');
  if (pkg !== null) out.push(...refusedPackageJson(pkg, { packageManagerFields: false }));
  const lock = read('package-lock.json');
  if (lock !== null) out.push(...refusedPackageLock(lock));
  return out;
}

function isLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function refusedPackageLock(content: string): ScaffoldFileRefusal[] {
  let lock: { packages?: Record<string, { resolved?: unknown; link?: unknown }> };
  try { lock = JSON.parse(content) as typeof lock; } catch { return [{ file: 'package-lock.json', reason: 'not JSON' }]; }
  const out: ScaffoldFileRefusal[] = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key || !entry || typeof entry !== 'object') continue;
    const at = `package-lock.json: ${key.slice(0, 120)}`;
    if (entry.link) out.push({ file: at, reason: 'a local link, not a registry package' });
    else if (entry.resolved !== undefined && !(typeof entry.resolved === 'string' && entry.resolved.startsWith(LOCK_REGISTRY))) {
      out.push({ file: at, reason: `resolved from "${String(entry.resolved).slice(0, 80)}", not from ${LOCK_REGISTRY}` });
    }
    if (out.length >= 20) break;
  }
  return out;
}

function refusedPackageJson(content: string, opts: { packageManagerFields?: boolean } = {}): ScaffoldFileRefusal[] {
  let pkg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    pkg = parsed as Record<string, unknown>;
  } catch {
    return [{ file: 'package.json', reason: 'not a JSON object' }];
  }
  const out: ScaffoldFileRefusal[] = [];
  for (const field of opts.packageManagerFields === false ? [] : PACKAGE_MANAGER_FIELDS) {
    if (pkg[field] !== undefined) out.push({ file: `package.json: ${field}`, reason: 'selects or configures the package manager the shell runs' });
  }
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (deps === undefined) continue;
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) {
      out.push({ file: `package.json: ${field}`, reason: 'not an object of name → version' });
      continue;
    }
    for (const [dep, spec] of Object.entries(deps as Record<string, unknown>)) {
      const at = `package.json: ${field}.${dep}`;
      if (typeof spec !== 'string') out.push({ file: at, reason: 'the version is not a string' });
      else if (dep.startsWith('@aura/') && (!AURA_NAME.test(dep) || !AURA_SPEC.test(spec))) {
        out.push({ file: at, reason: '@aura/* packages are <name>: x.y.z (or workspace:*)' });
      } else if (NOT_REGISTRY.test(spec)) {
        out.push({ file: at, reason: `"${spec.slice(0, 80)}" is not a registry package (local paths, git and URLs are installed in the app's own sandbox, not by the shell)` });
      }
    }
  }
  return out;
}
