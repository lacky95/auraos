import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { stdout, env as procEnv } from 'node:process';
import { color, fail, info, ok } from './format.js';

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

/**
 * Work around `docker exec -it`'s TTY-size race for jumped shells.
 *
 * docker reads the local TTY winsize once at attach and otherwise only
 * resizes the remote PTY when it receives a SIGWINCH. On a freshly-attached
 * interactive shell that the user doesn't manually resize, the remote PTY can
 * stay at node-pty's 80x24 default — so TUIs and line-wrapping inside the
 * jumped session render at 80 columns even though the host terminal is sized
 * correctly. The terminal app's own fit/resize logic can't help here: it sizes
 * the xterm/node-pty, not this new remote PTY.
 *
 * Emitting SIGWINCH at the docker client right after it starts forces it to
 * re-read our (correct) TTY size and POST it to the remote PTY. It's harmless
 * when the size is already right — it just re-applies the same dimensions.
 *
 * Two layers, both idempotent:
 *   1. Staggered initial nudges cover the gap between the child starting and
 *      docker finishing the attach + installing its SIGWINCH handler. They run
 *      a bit longer/denser than strictly needed so a slow daemon or cold image
 *      pull (attach >600 ms) still gets sized without the user touching the
 *      window.
 *   2. A live SIGWINCH forwarder for the child's whole lifetime: every resize
 *      the host TTY sees while we're jumped is re-posted to the docker client,
 *      so ongoing resizes propagate to the remote PTY even if process-group
 *      delivery races docker's own handler. Removed on exit so we don't leak a
 *      listener across successive jumps.
 */
export function syncDockerExecWinsize(child: ChildProcess): void {
  const nudge = () => { try { child.kill('SIGWINCH'); } catch { /* already exited */ } };
  child.once('spawn', () => {
    for (const ms of [120, 300, 600, 1200, 2000]) setTimeout(nudge, ms);
  });
  const onWinch = () => nudge();
  process.on('SIGWINCH', onWinch);
  child.on('exit', () => process.removeListener('SIGWINCH', onWinch));
}

/**
 * Drop into the target instance's sandbox in the CURRENT terminal session
 * (stdio: 'inherit' replaces our process). On exit, the user is back at
 * the calling shell. Dispatches on the instance's sandbox kind:
 *
 *   - 'proot'     → spawn `proot ...` with the same bind topology
 *                    ProotRunner uses at app boot, so the env inside this
 *                    exec shell matches what the live app sees.
 *   - 'container' → `docker exec -it aura-<instanceId> bash`. Joins the
 *                    sibling container's namespace directly — full kernel-
 *                    level isolation, identical to what `aura jump` users
 *                    expect when they say "isolated in that app".
 *
 * Requires (for container mode):
 *   - `docker` CLI on PATH of the calling shell (terminal proot gets this
 *     via the wildcard cap allowlist now that we copy it into the
 *     toolchain store).
 *   - `/var/run/docker.sock` bind-mounted into the calling sandbox so the
 *     CLI can reach the host daemon. ProotRunner binds it for any app
 *     whose manifest tools[] mentions 'docker' (incl. via '*' wildcard).
 */
export function enterSandbox(
  instanceId: string,
  appId: string,
  port: number | null,
  tools: string[],
  sandbox: 'proot' | 'container' | undefined,
  cmd?: string,
): void {
  if (sandbox === 'container') return enterContainer(instanceId, appId, cmd);
  return enterProot(instanceId, appId, port, tools, cmd);
}

/** Joins the sibling container's namespace via docker exec. */
function enterContainer(instanceId: string, appId: string, cmd?: string): void {
  // Mirrors ContainerRunner.containerName() — same sanitisation rule.
  const containerName = 'aura-' + instanceId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const appDir = `/workspace/apps/${appId}`;
  // Land in the app's folder so `pwd` shows the project, but DON'T override
  // HOME — the container is launched with HOME=/home/aura pointing at the
  // shared persistent volume, and we want CLI state (`~/.claude` etc.) to
  // survive across jumps. AURA_HOSTNAME is re-asserted defensively in case
  // someone reuses this function against a container that lacks it.
  // Pass through terminal-capability env so TUI apps (claude, htop, vim, …)
  // render the rich version, not the dumb fallback. node-pty in the Terminal
  // app's pty-server sets these for its own bash; without them, `docker exec`
  // inside a jumped session inherits a bare TERM=xterm and claude switches
  // to the compact one-line greeting instead of the boxed welcome card.
  //   • TERM=xterm-256color  → enables 256-colour + box-drawing detection
  //   • COLORTERM=truecolor  → unlocks the 24-bit colour paths
  //   • LANG=C.UTF-8         → UTF-8 box chars render correctly
  //   • LC_ALL falls back to LANG when unset; we set both so a parent that
  //     exported LC_ALL=C doesn't leak through and downgrade us.
  const termEnv: string[] = [];
  const passthrough: Record<string, string> = {
    TERM:       process.env['TERM']      ?? 'xterm-256color',
    COLORTERM:  process.env['COLORTERM'] ?? 'truecolor',
    LANG:       process.env['LANG']      ?? 'C.UTF-8',
    LC_ALL:     process.env['LC_ALL']    ?? 'C.UTF-8',
  };
  for (const [k, v] of Object.entries(passthrough)) termEnv.push('-e', `${k}=${v}`);
  const execArgs = [
    'exec', '-it',
    '--workdir', appDir,
    '-e', `AURA_HOSTNAME=${appId}`,
    ...termEnv,
    containerName,
  ];
  const shellArgs = cmd ? ['bash', '-lc', cmd] : ['bash', '-i'];
  const args = [...execArgs, ...shellArgs];
  info(`entering container ${color.bold(containerName)} (sandbox=container, cwd=${appDir})`);
  // Interactive jumps update the Terminal's host indicator; one-off `cmd` runs
  // don't (they return immediately and shouldn't flicker the bar).
  const restoreHost = cmd ? null : callerHostLabel();
  if (!cmd) setTerminalHost(appId);
  const child = spawn('docker', args, { stdio: 'inherit' });
  syncDockerExecWinsize(child);
  child.on('exit', (code) => {
    if (restoreHost) setTerminalHost(restoreHost);
    ok(`shell exited (code ${code ?? 0})`); process.exit(code ?? 0);
  });
  child.on('error', (err) => fail(
    `docker exec failed: ${err.message}\n` +
    `  Hint: the calling sandbox needs both the docker CLI on PATH and a bound /var/run/docker.sock.\n` +
    `  Terminal-proot apps get this automatically when their manifest tools[] include '*' (the wildcard\n` +
    `  cap allowlist now ships docker, and ProotRunner binds the host docker socket).`
  ));
}

/** Joins the proot-mode app's sandbox by spawning a sibling proot with
 *  the same bind topology ProotRunner uses at boot. */
function enterProot(
  instanceId: string,
  appId: string,
  port: number | null,
  tools: string[],
  cmd?: string,
): void {
  const appsDir   = process.env['AURA_APPS_DIR']      ?? '/workspace/apps';
  const dataDir   = process.env['AURA_DATA_DIR']      ?? '/data';
  const rootfs    = process.env['AURA_BASE_ROOTFS']   ?? '/os/base-rootfs';
  const toolchain = process.env['AURA_TOOLCHAIN_DIR'] ?? '/os/toolchain';
  const useProot  = process.env['AURA_USE_PROOT'] === 'true' && existsSync(rootfs);

  const appDir       = join(appsDir, appId);
  const instDataDir  = join(dataDir, 'apps', appId, instanceId);
  const toolBinDir   = join(toolchain, 'bin');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_ID: appId,
    APP_INSTANCE_ID: instanceId,
    APP_PORT: port?.toString() ?? '',
    OS_API_BASE: process.env['AURA_SHELL_URL'] ?? 'http://127.0.0.1:3000',
    // The host shell exports AURA_TERM_LABEL (= "aura-shell") to pin its own
    // title; clear it here so the jumped proot shows the app (via APP_ID),
    // not the host we jumped from. Container jumps get a fresh env, so this
    // leak only affects proot.
    AURA_TERM_LABEL: '',
  };

  const command = cmd ? ['bash', '-lc', cmd] : ['bash', '-i'];

  // Drive the Terminal's host indicator (interactive jumps only). Capture the
  // caller's label before spawning so we can restore the bar on exit.
  const restoreHost = cmd ? null : callerHostLabel();
  if (!cmd) setTerminalHost(appId);

  if (!useProot) {
    info(`PRoot disabled — opening shell in master cwd=${appDir}`);
    const child = spawn(command[0]!, command.slice(1), { cwd: appDir, env, stdio: 'inherit' });
    child.on('exit', (code) => {
      if (restoreHost) setTerminalHost(restoreHost);
      process.exit(code ?? 0);
    });
    return;
  }

  const args: string[] = [
    `--rootfs=${rootfs}`,
    '--bind=/workspace:/workspace',
    `--bind=${instDataDir}:/data`,
    '--bind=/proc',
    '--bind=/dev',
    '--bind=/tmp',
    '--bind=/etc/resolv.conf:/etc/resolv.conf',
    '--bind=/usr/local/bin/node:/usr/local/bin/node',
    `--cwd=${appDir}`,
  ];
  for (const tool of tools) {
    const binaryName = tool === 'claude-code' ? 'claude' : tool;
    const toolPath = join(toolBinDir, binaryName);
    if (existsSync(toolPath)) args.push(`--bind=${toolPath}:/usr/local/bin/${binaryName}`);
  }
  args.push(...command);

  info(`entering PRoot for ${color.bold(instanceId)} (sandbox=proot, cwd=${appDir})`);
  const child = spawn('proot', args, { env, stdio: 'inherit' });
  child.on('exit', (code) => {
    if (restoreHost) setTerminalHost(restoreHost);
    ok(`shell exited (code ${code ?? 0})`); process.exit(code ?? 0);
  });
  child.on('error', (err) => fail(`proot failed: ${err.message}`));
}

/** Back-compat shim. Older imports of `enterProot` still work. */
export { enterSandbox as enterProot };
