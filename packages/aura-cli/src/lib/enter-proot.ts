import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { color, fail, info, ok } from './format.js';

/**
 * Spawn a PRoot of `<appId>/<instanceId>` and replace this process's stdio
 * with the child's — i.e. the *same* terminal session enters the sandbox.
 * On exit, the user is back at the parent shell.
 *
 * Mirrors the bind topology that ProotRunner uses at app boot (rootfs +
 * /workspace + /data + /aura/all-tools + /aura/my-tools, etc.), so the
 * environment inside this exec shell matches what the app sees in its own
 * proot. The two-dir cap allowlist is NOT recreated here — for an interactive
 * dev shell the simpler model is to bind the toolchain entries listed in
 * the app's manifest directly at /usr/local/bin/<tool>, which is sufficient
 * for an admin walking around inside the sandbox.
 *
 * If PRoot is disabled (env var or absent rootfs), runs the shell against
 * the master cwd with no isolation — useful for apps with useProot:false
 * (Settings, Console) where the proot wouldn't help anyway.
 */
export function enterProot(
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

  info(`entering PRoot for ${color.bold(instanceId)} (cwd=${appDir})`);
  const child = spawn('proot', args, { env, stdio: 'inherit' });
  child.on('exit', (code) => { ok(`shell exited (code ${code ?? 0})`); process.exit(code ?? 0); });
  child.on('error', (err) => fail(`proot failed: ${err.message}`));
}
