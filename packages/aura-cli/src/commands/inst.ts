import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { api } from '../lib/client.js';
import { readManifest } from '../lib/manifest.js';
import { color, fail, info, ok, stateColor, table, uptime } from '../lib/format.js';

interface AppInstanceDto {
  instanceId: string;
  appId: string;
  state: string;
  port: number | null;
  pid: number | null;
  startedAt: string | null;
}

interface AppDto {
  manifest: { id: string };
  instances: AppInstanceDto[];
}

export function registerInst(program: Command): void {
  const inst = program.command('inst').alias('instance').description('Manage individual app instances.');

  inst
    .command('list')
    .alias('ls')
    .option('-a, --app <appId>', 'Filter by app ID')
    .description('List running instances (optionally filtered to one app).')
    .action(async (opts: { app?: string }) => {
      if (opts.app) {
        const list = await api.get<AppInstanceDto[]>(`/api/apps/${encodeURIComponent(opts.app)}/instances`);
        printList(list);
      } else {
        const apps = await api.get<AppDto[]>('/api/apps');
        printList(apps.flatMap((a) => a.instances));
      }
    });

  inst
    .command('info <instanceId>')
    .description('Print full status for an instance: manifest, state, activities.')
    .action(async (instanceId: string) => {
      const dto = await api.get(`/api/instances/${encodeURIComponent(instanceId)}/status`);
      console.log(JSON.stringify(dto, null, 2));
    });

  inst
    .command('stop <instanceId>')
    .description('Stop one instance gracefully (runs onPause/onStop/onDestroy hooks).')
    .action(async (instanceId: string) => {
      await api.post(`/api/instances/${encodeURIComponent(instanceId)}/stop`);
      ok(`stopped ${instanceId}`);
    });

  inst
    .command('kill <instanceId>')
    .description('Force-kill one instance with SIGKILL (no lifecycle hooks).')
    .action(async (instanceId: string) => {
      await api.post(`/api/instances/${encodeURIComponent(instanceId)}/kill`);
      ok(`killed ${instanceId}`);
    });

  inst
    .command('pause <instanceId>')
    .description('Pause an instance (calls onPause).')
    .action(async (instanceId: string) => {
      await api.post(`/api/instances/${encodeURIComponent(instanceId)}/pause`);
      ok(`paused ${instanceId}`);
    });

  inst
    .command('resume <instanceId>')
    .description('Resume a paused instance (calls onResume).')
    .action(async (instanceId: string) => {
      await api.post(`/api/instances/${encodeURIComponent(instanceId)}/resume`);
      ok(`resumed ${instanceId}`);
    });

  inst
    .command('shell <instanceId>')
    .option('-c, --cmd <cmd>', 'Run a single command instead of an interactive shell')
    .description('Drop into an interactive shell inside the running PRoot of an instance (docker-exec-style).')
    .action(async (instanceId: string, opts: { cmd?: string }) => {
      const dto = await api.get<{ appId: string; port: number | null }>(
        `/api/instances/${encodeURIComponent(instanceId)}/status`,
      );
      if (!dto.appId) fail(`Instance not found: ${instanceId}`);
      const manifest = readManifest(dto.appId);
      if (!manifest) fail(`Manifest missing for ${dto.appId}`);
      enterProot(instanceId, dto.appId, dto.port, manifest.tools ?? [], opts.cmd);
    });

  inst
    .command('logs <instanceId>')
    .option('-f, --follow', 'Follow new log lines')
    .description('Tail recent log output for an instance (V1: stub).')
    .action((instanceId: string, opts: { follow?: boolean }) => {
      console.error(color.yellow(`inst logs — not yet implemented (V2 will buffer to /data/aura/state/logs/${instanceId}.log).`));
      void opts;
      process.exit(2);
    });
}

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

  info(`entering PRoot for ${color.bold(instanceId)} (cwd=${appDir})`);
  const child = spawn('proot', args, { env, stdio: 'inherit' });
  child.on('exit', (code) => { ok(`shell exited (code ${code ?? 0})`); process.exit(code ?? 0); });
  child.on('error', (err) => fail(`proot failed: ${err.message}`));
}

function printList(list: AppInstanceDto[]): void {
  const rows = list.map((i) => ({
    INSTANCE: i.instanceId,
    APP:      i.appId,
    STATE:    stateColor(i.state),
    PORT:     i.port?.toString() ?? '-',
    PID:      i.pid?.toString() ?? '-',
    UPTIME:   uptime(i.startedAt),
  }));
  console.log(table(rows, ['INSTANCE', 'APP', 'STATE', 'PORT', 'PID', 'UPTIME']));
}
