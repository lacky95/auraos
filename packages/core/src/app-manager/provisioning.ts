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
 * Three rules share this module:
 *
 *  1. The same steps run at INSTALL time, where taking two minutes is
 *     expected and can be reported, in the throwaway builder container
 *     (`builderProvisionShell`, `ContainerRunner.provisionApp`; P5-3): as root
 *     inside that container only, never in the shell and never in the app.
 *
 *  2. The entrypoint of a ROOT app still provisions as a fallback — an app
 *     can be sideloaded, scaffolded by `aura dev new`, or gain a dependency
 *     after install — bracketed in markers, so a runner watching the log
 *     knows the app is being prepared and holds the boot budget open.
 *
 *  3. A NON-ROOT app (`runAs: app`) never installs: its start shell only
 *     reports "not provisioned" and exits non-zero (fail closed, visible).
 *     The kernel provisions it in the builder before its start.
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
if [ "$PROVISION" = 1 ] && [ "$(id -u)" != 0 ]; then
  # A non-root app never installs (P5-3): the OS builder does, before its start.
  echo "[\${APP_ID:-app}] not provisioned: its dependencies are installed by the OS builder, never by the app (run: aura build app \${APP_ID:-<app>})" >&2
  exit 1
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
 * Where an app server listens: every address, or, when the runner sets
 * `AURA_LISTEN_SUBNET` (a System Terminal, D58), only this container's own
 * IPv4 address inside that subnet. No such address means no start, never a
 * fallback to every address. Sets `LISTEN_HOST`.
 */
export const LISTEN_HOST_SCRIPT =
  'const [n,b]=process.argv[1].split("/"),m=b==0?0:~0<<32-b>>>0,' +
  'v=a=>a.split(".").reduce((x,o)=>(x*256+ +o)>>>0,0),' +
  'h=Object.values(require("os").networkInterfaces()).flat()' +
  '.find(i=>i&&i.family=="IPv4"&&(v(i.address)&m)>>>0==(v(n)&m)>>>0);' +
  'if(!h)process.exit(1);console.log(h.address)';
export const LISTEN_HOST_SHELL = `LISTEN_HOST=0.0.0.0
if [ -n "\${AURA_LISTEN_SUBNET:-}" ]; then
  LISTEN_HOST=$(node -e '${LISTEN_HOST_SCRIPT}' "$AURA_LISTEN_SUBNET") || { echo "[\${APP_ID:-app}] no address in AURA_LISTEN_SUBNET=$AURA_LISTEN_SUBNET; not starting" >&2; exit 1; }
fi`;

/**
 * The start command of an Astro app that ships no entrypoint of its own —
 * shared by ContainerRunner and ProotRunner (they used to carry a copy each).
 *
 * `AURA_SERVER_SEALED=1` (a user's session host, spawn/sessionArgs.ts): only
 * the production build, never `astro dev`, and the server runs from the
 * execute-only `node-sealed` (aura-base): the kernel makes a process started
 * from a binary its user can't read non-dumpable, so the user's own session
 * processes (same uid) can't read its /proc/<pid>/{environ,mem,fd,maps} or
 * ptrace it. Either missing: the start fails (exit 78), visibly.
 *
 * `AURA_SERVE=prod` (set by the runner when the app's build matches its
 * sources, see appBuild.ts) starts the production server: the app's own
 * `server.mjs` when it has one (apps with WebSockets etc.), else the adapter's
 * standalone entry. Anything else — or a build that vanished — runs
 * `astro dev` in the foreground, without Astro 7's lock file.
 */
export const ASTRO_START_SHELL = `set -e
export PORT="\${APP_PORT:-4001}"
${LISTEN_HOST_SHELL}
${PROVISION_SHELL}
NODE_BIN=node
if [ "\${AURA_SERVER_SEALED:-}" = 1 ]; then
  if [ "\${AURA_SERVE:-dev}" != prod ] || [ ! -f dist/server/entry.mjs ]; then
    echo "[\${APP_ID:-app}] refused: a sealed session host runs only from its current production build (no dev server)" >&2
    exit 78
  fi
  if [ ! -x /usr/local/bin/node-sealed ]; then
    echo "[\${APP_ID:-app}] refused: this aura-base image has no /usr/local/bin/node-sealed; rebuild aura-base" >&2
    exit 78
  fi
  NODE_BIN=/usr/local/bin/node-sealed
fi
if [ "\${AURA_SERVE:-dev}" = prod ] && [ -f dist/server/entry.mjs ]; then
  export HOST="$LISTEN_HOST" NODE_ENV=production
  if [ -f server.mjs ]; then
    echo "[\${APP_ID:-app}] Starting production server (server.mjs) on port \$PORT"
    exec "\$NODE_BIN" server.mjs
  fi
  echo "[\${APP_ID:-app}] Starting production server (dist) on port \$PORT"
  exec "\$NODE_BIN" dist/server/entry.mjs
fi
ASTRO="node_modules/.bin/astro"
[ -x "\$ASTRO" ] || ASTRO="/workspace/node_modules/.bin/astro"
echo "[\${APP_ID:-app}] Starting Astro server on port \$PORT via \$ASTRO"
# The runner supervises this process: Astro 7 must neither detach it when it
# detects an agent (ASTRO_DEV_BACKGROUND=0) nor refuse a second instance of
# the same app dir over its .astro/dev.json lock (--ignore-lock). Astro 6
# had neither. os/boot.sh does the same for the shell.
export ASTRO_DEV_BACKGROUND=0
exec "\$ASTRO" dev --host "\$LISTEN_HOST" --port "\$PORT" --ignore-lock`;

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

/** Does this app still need dependencies installed? */
export function needsProvisioning(appDir: string, runtime: AppRuntime = 'astro'): boolean {
  if (!existsSync(join(appDir, 'package.json'))) return false;
  if (npmMissing(appDir, runtime)) return true;
  return referencesAuraPackages(appDir) && !existsSync(join(appDir, 'node_modules', '@aura'));
}

type AppRuntime = keyof typeof NPM_MISSING_SHELL;

/** NPM_MISSING_SHELL in TypeScript, for the kernel's checks. */
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

/** Where the builder keeps package caches: never a home (P5-3). */
export const BUILDER_CACHE_SUBPATH = 'aura/cache/builder';
export const BUILDER_CACHE_PATH = '/aura-cache';

/** The builder's env: caches in the builder cache dir; no token, no context, no home. */
export function builderProvisionEnv(appId: string): string[] {
  return [
    '-e', `APP_ID=${appId}`,
    '-e', `HOME=${BUILDER_CACHE_PATH}/home`,
    '-e', `npm_config_cache=${BUILDER_CACHE_PATH}/npm`,
    '-e', `npm_config_store_dir=${BUILDER_CACHE_PATH}/pnpm-store`,
    '-e', `XDG_CACHE_HOME=${BUILDER_CACHE_PATH}/xdg`,
    '-e', 'npm_config_update_notifier=false',
    '-e', 'ASTRO_TELEMETRY_DISABLED=1',
  ];
}

/**
 * The provisioning of the throwaway builder (P5-3): the start shell's own
 * block, so the two can never drift, as root in the builder container. The
 * `aura` CLI comes from the read-only packages mount. Fails when the app
 * still needs provisioning afterwards.
 */
export function builderProvisionShell(runtime: AppRuntime): string {
  return `set -e
mkdir -p "$HOME"
aura() { node /workspace/packages/aura-cli/dist/aura.cjs "$@"; }
${provisionShell(runtime)}
if ${NPM_MISSING_SHELL[runtime]}; then
  echo "[\${APP_ID:-app}] provisioning did not install the dependencies" >&2
  exit 1
fi`;
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
