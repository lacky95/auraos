import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { color, fail, info, ok } from './format.js';

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
  const child = spawn('docker', args, { stdio: 'inherit' });
  child.on('exit', (code) => { ok(`shell exited (code ${code ?? 0})`); process.exit(code ?? 0); });
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
  };

  const command = cmd ? ['bash', '-lc', cmd] : ['bash', '-i'];

  if (!useProot) {
    info(`PRoot disabled — opening shell in master cwd=${appDir}`);
    const child = spawn(command[0]!, command.slice(1), { cwd: appDir, env, stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
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
  child.on('exit', (code) => { ok(`shell exited (code ${code ?? 0})`); process.exit(code ?? 0); });
  child.on('error', (err) => fail(`proot failed: ${err.message}`));
}

/** Back-compat shim. Older imports of `enterProot` still work. */
export { enterSandbox as enterProot };
