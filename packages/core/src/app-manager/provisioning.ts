/**
 * Dependency provisioning — the work an app needs done *before* it can boot.
 *
 * A user/global-scope app arrives from the store as source: package.json, a
 * lockfile, src/. Nothing runnable. Someone has to `npm install` its tree and
 * pull the `@aura/*` packages named in `auraDependencies` over OCI before
 * `astro dev` can start.
 *
 * That work used to happen only inside the synthesised entrypoint, on the
 * launch path, inside the runner's health deadline — so the runner was timing
 * "install this app's dependencies" with a budget meant for "answer a health
 * check". An app with a large tree (onnxruntime, wasm blobs) cannot finish in
 * 60s, so its first launch was killed mid-install every time and only worked
 * on the retry that found a warm node_modules. Installed-but-unlaunchable is
 * the worst possible resting state for a store.
 *
 * Two changes share this module:
 *
 *  1. `provisionApp()` runs the same steps at INSTALL time, where taking two
 *     minutes is expected and can be reported. After it, first launch is a
 *     boot like any other.
 *
 *  2. The entrypoint still provisions as a fallback — an app can be
 *     sideloaded, scaffolded by `aura dev new`, or gain a dependency after
 *     install — but now brackets that work in markers. A runner watching the
 *     log knows the app is being prepared rather than failing to start, and
 *     holds the boot budget open instead of killing it.
 *
 * Install scripts never run as root in the shell (owner 2026-11-27: "without
 * allowing untrusted scripts to execute as root"). provisionApp installs
 * unprivileged with scripts off (unprivilegedInstall.ts); the scripts it
 * skipped are listed in PENDING_BUILDS_FILE and run by the entrypoint in the
 * app's own container (AURA_DEP_BUILDS=1, ContainerRunner), as the app. A
 * sandbox that shares the master (PRoot) never runs install scripts.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { installStoreDepsUnprivileged, type StoreInstallOpts } from './unprivilegedInstall.js';

/** Printed by the synthesised entrypoint around the provisioning block. */
export const PROVISION_BEGIN = '@@aura:provision:begin@@';
export const PROVISION_END   = '@@aura:provision:end@@';

/**
 * The install scripts a shell-side install skipped (one per line), for the
 * app's own sandbox to run at its next start. Inside node_modules, so a fresh
 * install (or deleting node_modules) clears it with the tree it belongs to.
 */
export const PENDING_BUILDS_FILE = 'node_modules/.aura-pending-builds';

/** Root lifecycle scripts `npm install` runs after the dependencies, in its order. */
const ROOT_INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'] as const;
/** A dependency's install scripts (`npm rebuild` runs them; binding.gyp alone means `node-gyp rebuild`). */
const DEP_INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'] as const;

/**
 * Absolute ceiling on provisioning, so a wedged install still fails rather
 * than hanging a start forever. Generous on purpose: this bounds a cold
 * dependency install on a slow link, not a health check.
 */
export const PROVISION_TIMEOUT_MS = 15 * 60_000;

/**
 * Tracks whether an app's entrypoint is currently provisioning, by watching
 * its log for the markers above.
 *
 * Deliberately a state machine over the log rather than a probe into the
 * container: the runners already fan the app's stdout into the shell's, so
 * this costs one substring check per chunk and needs no extra `docker exec`
 * on every 200ms health poll.
 */
export class ProvisionWatch {
  private active = false;
  private seen   = false;

  /** Feed a chunk of app output. Safe to call with partial lines. */
  observe(chunk: string): void {
    // Order matters: a single chunk can contain both markers when a warm app
    // provisions nothing, and "ended" is the correct resting state for that.
    if (chunk.includes(PROVISION_BEGIN)) { this.active = true; this.seen = true; }
    if (chunk.includes(PROVISION_END))   { this.active = false; }
  }

  /** True while the entrypoint is installing dependencies. */
  get isProvisioning(): boolean { return this.active; }
  /** True once provisioning has been seen at all — for error messages. */
  get everProvisioned(): boolean { return this.seen; }
}

/**
 * When an app's npm tree counts as installed, per runtime. The OS starts an
 * Astro app itself, so it needs `astro`. A raw app starts through its own
 * entrypoint, so any installed tree will do, and one without dependencies
 * needs none. needsProvisioning() and provisionApp() apply the same rule.
 */
const NPM_MISSING_SHELL = {
  astro: '[ ! -x "node_modules/.bin/astro" ] && [ ! -x "/workspace/node_modules/.bin/astro" ]',
  raw: `[ ! -d node_modules ] && node -e 'process.exit(Object.keys(require("./package.json").dependencies || {}).length ? 0 : 1)' 2>/dev/null`,
} as const;

/**
 * The provisioning block an app's start runs first, as shell source.
 *
 * Shared by both runners so the markers can never drift from the work they
 * bracket. Written with explicit `if` blocks: under `set -e` a bare
 * `[ -x foo ] && VAR=1` exits the script when the test is false.
 */
export function provisionShell(runtime: 'astro' | 'raw'): string {
  const npmMissing = NPM_MISSING_SHELL[runtime];
  return `PROVISION=0
if ${npmMissing}; then
  PROVISION=1
fi
if [ ! -d node_modules/@aura ] && grep -qE '"(aura)?[dD]ependencies"|"@aura/' package.json 2>/dev/null; then
  PROVISION=1
fi
if [ -f ${PENDING_BUILDS_FILE} ]; then
  PROVISION=1
fi
if [ "$PROVISION" = 1 ]; then
  # Bracket the slow part so the runner can tell "being prepared" from
  # "failing to boot" and hold its health budget open. See provisioning.ts.
  echo "${PROVISION_BEGIN}"
  # Install scripts run only in the app's own container (the runner sets
  # AURA_DEP_BUILDS=1), never in a sandbox that shares the master (PRoot).
  SCRIPTS=""
  if [ "\${AURA_DEP_BUILDS:-0}" != 1 ]; then SCRIPTS="--ignore-scripts"; fi
  if ${npmMissing}; then
    # Install with the package manager the lockfile belongs to. A pnpm
    # project installed by npm resolves from scratch and can miss
    # platform-specific optional deps (npm/cli#4828, e.g. rollup's native
    # binary). pnpm isn't in the base image, so fall back to npx, pinned
    # to package.json's "packageManager" when it names pnpm.
    if [ -f pnpm-lock.yaml ]; then
      PNPM_SPEC=$(sed -n 's/.*"packageManager": *"\\(pnpm@[^"+]*\\).*/\\1/p' package.json 2>/dev/null | head -n1)
      if command -v pnpm >/dev/null; then PNPM="pnpm"; else PNPM="npx --yes \${PNPM_SPEC:-pnpm@latest}"; fi
      # An app with no pnpm-workspace.yaml of its own would resolve upward to
      # the OS workspace file mounted at /workspace and fail on its lockfile.
      PNPM_SCOPE=""
      if [ ! -f pnpm-workspace.yaml ]; then PNPM_SCOPE="--ignore-workspace"; fi
      echo "[\${APP_ID:-app}] pnpm install via '\$PNPM' (dependencies not yet installed)..."
      \$PNPM install \$PNPM_SCOPE \$SCRIPTS --frozen-lockfile 2>&1 || \$PNPM install \$PNPM_SCOPE \$SCRIPTS 2>&1 \\
        || echo "[\${APP_ID:-app}] WARNING: pnpm install exited non-zero (often just ignored build scripts) — trying to boot anyway"
    else
      echo "[\${APP_ID:-app}] npm install (dependencies not yet installed)..."
      npm install \$SCRIPTS --prefer-offline 2>&1 || npm install \$SCRIPTS
    fi
  fi
  if [ -f ${PENDING_BUILDS_FILE} ]; then
    if [ -z "\$SCRIPTS" ]; then
      # The install scripts the store install skipped in the shell, run here
      # as the app: the dependencies' (npm rebuild), then the app's own, in
      # npm install's order (--ignore-scripts: exactly that script, no pre/post).
      echo "[\${APP_ID:-app}] running the dependency install scripts in the app's sandbox: \$(tr '\\n' ' ' < ${PENDING_BUILDS_FILE})"
      if npm rebuild --foreground-scripts 2>&1${ROOT_INSTALL_SCRIPTS.map((s) => ` && npm run --ignore-scripts --if-present ${s} 2>&1`).join('')}; then
        rm -f ${PENDING_BUILDS_FILE}
      else
        echo "[\${APP_ID:-app}] WARNING: a dependency install script failed (retried at the next start) — trying to boot anyway"
      fi
    else
      echo "[\${APP_ID:-app}] WARNING: install scripts not run (this sandbox shares the master): \$(tr '\\n' ' ' < ${PENDING_BUILDS_FILE})"
    fi
  fi
  if [ ! -d node_modules/@aura ] && grep -qE '"(aura)?[dD]ependencies"|"@aura/' package.json 2>/dev/null; then
    # Never fatal (the app may still boot), but never silent either: a
    # missing @aura/app-sdk otherwise surfaces only as "Unable to load
    # your Astro config".
    if ! command -v aura >/dev/null; then
      echo "[\${APP_ID:-app}] WARNING: aura CLI not on PATH — @aura/* deps not installed"
    elif ! aura sdk install --quiet; then
      echo "[\${APP_ID:-app}] WARNING: aura sdk install failed — @aura/* deps missing"
    fi
  fi
  echo "${PROVISION_END}"
fi`;
}

/** The provisioning block of an Astro app (kept as a constant for the tests). */
export const PROVISION_SHELL = provisionShell('astro');

/**
 * The start command of a raw app: the same provisioning as an Astro app,
 * then the app's own entrypoint (`$1`). Raw apps used to skip provisioning,
 * so an app that imports `@aura/app-sdk` only booted after a manual
 * `aura sdk install`.
 */
export const RAW_START_SHELL = `set -e
${provisionShell('raw')}
exec bash "$1"`;

/**
 * The start command of an Astro app that ships no entrypoint of its own —
 * shared by ContainerRunner and ProotRunner (they used to carry a copy each).
 *
 * `AURA_SERVE=prod` (set by the runner when the app's build matches its
 * sources, see appBuild.ts) starts the production server: the app's own
 * `server.mjs` when it has one (apps with WebSockets etc.), else the adapter's
 * standalone entry. Anything else — or a build that vanished — runs
 * `astro dev` in the foreground, without Astro 7's lock file.
 */
export const ASTRO_START_SHELL = `set -e
export PORT="\${APP_PORT:-4001}"
${PROVISION_SHELL}
if [ "\${AURA_SERVE:-dev}" = prod ] && [ -f dist/server/entry.mjs ]; then
  export HOST=0.0.0.0 NODE_ENV=production
  if [ -f server.mjs ]; then
    echo "[\${APP_ID:-app}] Starting production server (server.mjs) on port \$PORT"
    exec node server.mjs
  fi
  echo "[\${APP_ID:-app}] Starting production server (dist) on port \$PORT"
  exec node dist/server/entry.mjs
fi
ASTRO="node_modules/.bin/astro"
[ -x "\$ASTRO" ] || ASTRO="/workspace/node_modules/.bin/astro"
echo "[\${APP_ID:-app}] Starting Astro server on port \$PORT via \$ASTRO"
# The runner supervises this process: Astro 7 must neither detach it when it
# detects an agent (ASTRO_DEV_BACKGROUND=0) nor refuse a second instance of
# the same app dir over its .astro/dev.json lock (--ignore-lock). Astro 6
# had neither. os/boot.sh does the same for the shell.
export ASTRO_DEV_BACKGROUND=0
exec "\$ASTRO" dev --host 0.0.0.0 --port "\$PORT" --ignore-lock`;

/**
 * The health-wait deadline for the next poll.
 *
 * Extracted from both runners so the rule is stated once and can be tested
 * without spawning a container: while the entrypoint is provisioning, the app
 * has not been asked to start yet, so the boot budget is pushed back and only
 * begins counting when provisioning ends. `hardDeadline` bounds the whole
 * wait so a wedged install still fails.
 */
export function nextHealthDeadline(opts: {
  now:            number;
  deadline:       number;
  hardDeadline:   number;
  isProvisioning: boolean;
  bootBudgetMs:   number;
}): number {
  const { now, deadline, hardDeadline, isProvisioning, bootBudgetMs } = opts;
  if (!isProvisioning || now >= hardDeadline) return deadline;
  // Never pull the deadline in — a slow provision must not shorten a boot
  // budget that is already running longer than one poll's worth.
  return Math.max(deadline, Math.min(now + bootBudgetMs, hardDeadline));
}

export interface ProvisionResult {
  /** Steps actually run, in order. Empty when the app was already ready. */
  ran:      string[];
  /** Non-fatal problems worth surfacing; provisioning still succeeded. */
  warnings: string[];
}

/** Does this app still need dependencies installed? */
export function needsProvisioning(appDir: string, runtime: AppRuntime = 'astro'): boolean {
  if (!existsSync(join(appDir, 'package.json'))) return false;
  if (npmMissing(appDir, runtime)) return true;
  return referencesAuraPackages(appDir) && !existsSync(join(appDir, 'node_modules', '@aura'));
}

type AppRuntime = keyof typeof NPM_MISSING_SHELL;

/** NPM_MISSING_SHELL in TypeScript, for the install-time path. */
function npmMissing(appDir: string, runtime: AppRuntime): boolean {
  if (runtime === 'astro') return !existsSync(join(appDir, 'node_modules', '.bin', 'astro'));
  if (existsSync(join(appDir, 'node_modules'))) return false;
  try {
    const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf-8')) as { dependencies?: Record<string, string> };
    return Object.keys(pkg.dependencies ?? {}).length > 0;
  } catch { return false; }
}

function referencesAuraPackages(appDir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>; auraDependencies?: Record<string, string>;
    };
    if (pkg.auraDependencies && Object.keys(pkg.auraDependencies).length) return true;
    return Object.keys(pkg.dependencies ?? {}).some((d) => d.startsWith('@aura/'));
  } catch { return false; }
}

/**
 * The install scripts an install with scripts off skipped: the app's own
 * lifecycle scripts and every installed package with an install script (or a
 * binding.gyp). Symlinks are not followed.
 */
export function pendingDependencyBuilds(appDir: string): string[] {
  const out: string[] = [];
  const pkg = readPkg(join(appDir, 'package.json'));
  for (const s of ROOT_INSTALL_SCRIPTS) if (pkg?.scripts?.[s]) out.push(`${pkg.name ?? 'app'} (${s})`);
  const seen = new Set<string>();
  const walk = (nm: string, depth: number): void => {
    let names: string[];
    try { names = readdirSync(nm); } catch { return; }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const dir = join(nm, name);
      if (!isDir(dir)) continue;
      if (name.startsWith('@')) { walk(dir, depth); continue; }
      const dep = readPkg(join(dir, 'package.json'));
      if (!dep) continue;
      const scripts = DEP_INSTALL_SCRIPTS.filter((s) => dep.scripts?.[s]);
      if (scripts.length || existsSync(join(dir, 'binding.gyp'))) {
        const id = `${dep.name ?? name}@${dep.version ?? '?'}`;
        if (!seen.has(id)) { seen.add(id); out.push(`${id} (${scripts.length ? scripts.join(', ') : 'binding.gyp'})`); }
      }
      if (depth < 12) walk(join(dir, 'node_modules'), depth + 1);
    }
  };
  walk(join(appDir, 'node_modules'), 0);
  return out;
}

function isDir(p: string): boolean {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}

function readPkg(p: string): { name?: string; version?: string; scripts?: Record<string, string> } | null {
  try { return JSON.parse(readFileSync(p, 'utf-8')) as { name?: string; version?: string; scripts?: Record<string, string> }; }
  catch { return null; }
}

/**
 * Install an app's dependencies at install time (Nexus install, update, patch
 * activation), never as root and never running an install script: the
 * unprivileged install (unprivilegedInstall.ts) as the install user, scripts
 * off, in a work dir; node_modules is then moved into the app dir — the dir
 * the app's sandbox later mounts. The scripts it skipped go to
 * PENDING_BUILDS_FILE for the app's own sandbox. `onLine` receives command
 * output for progress.
 *
 * Never throws for a failed `aura sdk install`: an app that declares no
 * `@aura/*` package, or a registry that is briefly down, must not turn a
 * working install into a failed one. A failed `npm install` DOES throw —
 * without it there is no app.
 */
export async function provisionApp(
  appDir:   string,
  onLine?:  (line: string) => void,
  runtime:  AppRuntime = 'astro',
  /** The unprivileged install's paths and identity (tests). */
  install:  Partial<Pick<StoreInstallOpts, 'paths' | 'env' | 'uid' | 'gid'>> = {},
): Promise<ProvisionResult> {
  if (!existsSync(join(appDir, 'package.json'))) return { ran: [], warnings: [] };
  const npm = npmMissing(appDir, runtime);
  // A fresh node_modules replaces the app's, @aura/* included.
  const sdk = referencesAuraPackages(appDir) && (npm || !existsSync(join(appDir, 'node_modules', '@aura')));
  if (!npm && !sdk) return { ran: [], warnings: [] };
  const result = await installStoreDepsUnprivileged(appDir, { ...install, npm, sdk, ...(onLine ? { onLine } : {}) });
  if (npm && existsSync(join(appDir, 'node_modules'))) {
    const pending = pendingDependencyBuilds(appDir);
    if (pending.length) {
      writeFileSync(join(appDir, PENDING_BUILDS_FILE), `${pending.join('\n')}\n`);
      result.warnings.push(`install scripts not run by the install; a container sandbox runs them at the app's first start: ${pending.join(', ')}`);
    }
  }
  return result;
}

/** Does this app hold a registry copy of @aura/* (not workspace links) to keep current? */
export function hasRegistryAuraPackages(appDir: string): boolean {
  if (!existsSync(join(appDir, 'node_modules', '@aura'))) return false;
  try {
    const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf-8')) as Record<string, Record<string, string> | undefined>;
    return [pkg['dependencies'], pkg['devDependencies'], pkg['auraDependencies']]
      .flatMap((d) => Object.entries(d ?? {}))
      .some(([name, spec]) => name.startsWith('@aura/') && !String(spec).startsWith('workspace:'));
  } catch { return false; }
}

/**
 * Refresh an installed app's @aura/* copies from the local registry. Apps not
 * provisioned yet are left to provisionApp. Returns a warning on failure and
 * never throws: the app keeps the copy it has, so it stays usable offline.
 */
export async function refreshAuraPackages(appDir: string): Promise<string | null> {
  if (!hasRegistryAuraPackages(appDir)) return null;
  const code = await run('aura', ['sdk', 'install', '--quiet'], appDir);
  return code === 0 ? null : `aura sdk install failed (exit ${code}) — keeping the installed @aura/* packages`;
}

function run(
  cmd: string, args: string[], cwd: string, onLine?: (line: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const emit = (d: Buffer) => {
      for (const l of d.toString().split('\n')) if (l.trim()) onLine?.(l.trim());
    };
    child.stdout?.on('data', emit);
    child.stderr?.on('data', emit);
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
  });
}
