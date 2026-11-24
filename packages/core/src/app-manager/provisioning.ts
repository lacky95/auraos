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
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

/** Printed by the synthesised entrypoint around the provisioning block. */
export const PROVISION_BEGIN = '@@aura:provision:begin@@';
export const PROVISION_END   = '@@aura:provision:end@@';

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
if [ "$PROVISION" = 1 ]; then
  # Bracket the slow part so the runner can tell "being prepared" from
  # "failing to boot" and hold its health budget open. See provisioning.ts.
  echo "${PROVISION_BEGIN}"
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
      \$PNPM install \$PNPM_SCOPE --frozen-lockfile 2>&1 || \$PNPM install \$PNPM_SCOPE 2>&1 \\
        || echo "[\${APP_ID:-app}] WARNING: pnpm install exited non-zero (often just ignored build scripts) — trying to boot anyway"
    else
      echo "[\${APP_ID:-app}] npm install (dependencies not yet installed)..."
      npm install --prefer-offline 2>&1 || npm install
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
 * `astro dev`, exactly as before.
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
exec "\$ASTRO" dev --host 0.0.0.0 --port "\$PORT"`;

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
 * Install an app's dependencies in place.
 *
 * Runs in the OS container against the app's directory on the shared data
 * volume — the same directory the app container later bind-mounts, so the
 * work is visible to it. `onLine` receives command output for progress.
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
): Promise<ProvisionResult> {
  const result: ProvisionResult = { ran: [], warnings: [] };
  if (!existsSync(join(appDir, 'package.json'))) return result;

  if (npmMissing(appDir, runtime)) {
    result.ran.push('npm install');
    const code = await run('npm', ['install', '--prefer-offline'], appDir, onLine);
    if (code !== 0) {
      // --prefer-offline can fail on a stale/partial cache; the retry is the
      // same fallback the entrypoint has always had.
      onLine?.('npm install --prefer-offline failed, retrying online…');
      const retry = await run('npm', ['install'], appDir, onLine);
      if (retry !== 0) throw new Error(`npm install failed in ${appDir} (exit ${retry})`);
    }
  }

  if (referencesAuraPackages(appDir) && !existsSync(join(appDir, 'node_modules', '@aura'))) {
    result.ran.push('aura sdk install');
    const code = await run('aura', ['sdk', 'install', '--quiet'], appDir, onLine);
    if (code !== 0) {
      // Left to the entrypoint to retry at launch, which is why that fallback
      // stays. Surfaced rather than swallowed so a broken registry is visible.
      result.warnings.push(
        `aura sdk install failed (exit ${code}) — @aura/* packages will be pulled at first launch instead`,
      );
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
