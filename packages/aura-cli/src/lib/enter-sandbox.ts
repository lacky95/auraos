import { stdout, env as procEnv } from 'node:process';
import { color, fail, info, ok, warn } from './format.js';
import { runSession, type HomeMode, type SessionRequest } from './exec-client.js';

/**
 * Tell the AuraOS Terminal which sandbox the live shell is now in.
 *
 * This is how `aura jump` "communicates" with the Terminal app: it writes an
 * OSC window-title sequence to its OWN stdout. That sequence rides the same
 * PTY stream straight back to the terminal that launched us, so it's always
 * routed to the right session — no session id, no out-of-band API call. The
 * Terminal page picks it up via xterm's onTitleChange and updates its host
 * indicator. Doing it here (rather than only via the shell's PROMPT_COMMAND)
 * means the bar updates the instant we jump, even if the destination shell
 * never loads bashrc.aura.sh.
 */
export function setTerminalHost(label: string): void {
  if (!stdout.isTTY || !label) return;
  try { stdout.write(`\x1b]0;${label}\x07`); } catch { /* not a tty */ }
}

/** Host label of wherever we're jumping FROM — restored on exit so the bar
 *  snaps back when the user leaves the sandbox. Mirrors bashrc's fallback
 *  order; read before we spawn so it reflects the caller, not the child. */
export function callerHostLabel(): string {
  return procEnv['AURA_TERM_LABEL']
    || procEnv['AURA_HOSTNAME']
    || procEnv['APP_ID']
    || procEnv['HOSTNAME']
    || 'aura-shell';
}

export const HOME_MODES: readonly HomeMode[] = ['private', 'app', 'ephemeral'];

/** `--home`: private (default), app or ephemeral; anything else fails. */
export function parseHomeMode(v: string | undefined): HomeMode | undefined {
  if (v === undefined) return undefined;
  if (!(HOME_MODES as readonly string[]).includes(v)) fail(`--home must be one of ${HOME_MODES.join(', ')}`);
  return v as HomeMode;
}

/** The positional-argument jump into `startDir`, with today's fallback message. */
function startDirArgv(startDir: string): string[] {
  return ['bash', '-c', 'cd -- "$1" 2>/dev/null || printf "Workspace unavailable; using %s\\n" "$PWD"; exec bash -i', 'aura-jump', startDir];
}

/**
 * Run a session through the shell's exec bridge (lib/exec-client.ts) and exit
 * with its code. There is no other path (stream J, D36): the CLI never runs
 * docker or proot itself; a target the bridge refuses (a PRoot runtime, a
 * root instance for --home private) is reported as refused.
 */
function viaBridge(req: SessionRequest, label: string | null): void {
  const restoreHost = label ? callerHostLabel() : null;
  if (label) setTerminalHost(label);
  void runSession(req).then((r) => {
    if (restoreHost) setTerminalHost(restoreHost);
    if (!r.opened) fail(`session refused: ${r.reason}`);
    if (label) ok(`shell exited (code ${r.code ?? 1})`);
    process.exit(r.code ?? 1);
  });
}

export interface EnterOpts {
  /** A one-off command (`bash -lc`); none = an interactive shell. */
  cmd?: string;
  /** Interactive cwd inside the sandbox. */
  startDir?: string;
  /** D67: private (default), app or ephemeral. */
  home?: HomeMode;
}

/**
 * Enter the RUNNING instance (D74): a session inside its environment with
 * the chosen home, opened by the shell (stream J). `exec` is the same
 * session without a TTY (J.4).
 */
export function enterSandbox(instanceId: string, appId: string, opts: EnterOpts = {}): void {
  const { cmd, startDir, home } = opts;
  const tty = !cmd || (process.stdin.isTTY && stdout.isTTY);
  const argv = cmd ? ['bash', '-lc', cmd] : startDir ? startDirArgv(startDir) : undefined;
  if (!cmd) {
    info(`entering ${color.bold(instanceId)} (home: ${home ?? 'private'})`);
    // J.3 residual risk: whatever runs from the app's tree runs with the user's Private Home.
    if ((home ?? 'private') === 'private') warn('this app\'s code runs with your home; use --home ephemeral for untrusted apps');
  }
  viaBridge({ instanceId, kind: cmd ? 'exec' : 'jump', tty, ...(argv ? { argv } : {}), ...(home ? { home } : {}) }, cmd ? null : appId);
}

/**
 * Enter (or run a command in) a SIDECAR of an instance: an owner-only bridge
 * exec in the actual sidecar with its image user, never a Private Home (J.4).
 * Sidecars run foreign images: an interactive entry prefers bash and falls
 * back to sh; a `cmd` is exec'd as given (argv, no shell).
 */
export function enterSidecar(instanceId: string, service: string, label: string, cmd?: string[]): void {
  const interactive = !cmd || cmd.length === 0;
  if (interactive) info(`entering sidecar ${color.bold(label)}`);
  viaBridge({
    instanceId, sidecar: service, kind: interactive ? 'jump' : 'exec',
    tty: interactive || (process.stdin.isTTY && stdout.isTTY), ...(interactive ? {} : { argv: cmd! }),
  }, interactive ? label : null);
}
