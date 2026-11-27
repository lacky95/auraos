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
 */
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

function refusedPackageJson(content: string): ScaffoldFileRefusal[] {
  let pkg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    pkg = parsed as Record<string, unknown>;
  } catch {
    return [{ file: 'package.json', reason: 'not a JSON object' }];
  }
  const out: ScaffoldFileRefusal[] = [];
  for (const field of PACKAGE_MANAGER_FIELDS) {
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
