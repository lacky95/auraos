import type { Command } from 'commander';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { api, shellUrl } from '../lib/client.js';
import { color } from '../lib/format.js';
import { provenanceLine, releaseLine, SYSTEM_CHANGES, type ReleaseView } from './systemMode.js';

interface AppDto {
  manifest: { id: string };
  instances: Array<{ state: string }>;
  activities: unknown[];
}

function countBinaries(dir: string): number {
  try {
    return readdirSync(dir).filter((f) => {
      try { return statSync(join(dir, f)).isFile() || statSync(join(dir, f)).isSymbolicLink(); }
      catch { return false; }
    }).length;
  } catch { return 0; }
}

function dirSize(dir: string): string {
  if (!existsSync(dir)) return '-';
  try {
    const st = statSync(dir);
    return st.isDirectory() ? 'present' : '-';
  } catch { return '-' ; }
}

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('Print a summary of AuraOS health: shell, apps, capabilities, services, paths.')
    .action(async () => {
      let shellOk = false;
      let apps: AppDto[] = [];
      try {
        apps = await api.get<AppDto[]>('/api/apps');
        shellOk = true;
      } catch {
        shellOk = false;
      }

      const installed = apps.length;
      const running   = apps.filter((a) => a.instances.some((i) => i.state !== 'destroyed' && i.state !== 'error')).length;
      const instances = apps.reduce((n, a) => n + a.instances.length, 0);
      const activities = apps.reduce((n, a) => n + a.activities.length, 0);

      const toolchain = process.env['AURA_TOOLCHAIN_DIR'] ?? '/os/toolchain';
      const rootfs    = process.env['AURA_BASE_ROOTFS']   ?? '/os/base-rootfs';
      const appsDir   = process.env['AURA_APPS_DIR']      ?? '/workspace/apps';
      const dataDir   = process.env['AURA_DATA_DIR']      ?? '/data';
      const toolchainBins = countBinaries(join(toolchain, 'bin'));
      // D60, D34: the system mode (the owner's view; '-' for a caller that may not read it), and in
      // Normal Mode the release it runs from and where system changes go.
      let systemMode = '-';
      let release: ReleaseView | null = null;
      if (shellOk) {
        try {
          const m = await api.get<{ mode: string; normalEnforced?: boolean; release?: ReleaseView | null }>('/api/admin/system-mode');
          release = m.normalEnforced && m.release ? m.release : null;
          systemMode = m.mode === 'developer' ? color.yellow('developer')
            : release ? `normal (${releaseLine(release)})` : `normal${color.dim(' (recorded; this install runs from its checkout)')}`;
        } catch { /* not the owner's */ }
      }
      // The running version: the release's, else the checkout's package.json (no hard-coded version).
      let version = release?.version ?? null;
      if (!version && shellOk) {
        try { version = (await api.get<{ version?: string }>('/api/os/about')).version ?? null; } catch { /* unknown */ }
      }

      console.log(color.bold('AuraOS') + ' ' + color.dim(version ? `v${version}` : 'version unknown'));
      console.log('  Shell:        ' + (shellOk ? color.green(shellUrl()) : color.red(`${shellUrl()} (unreachable)`)));
      console.log(`  System mode:  ${systemMode}`);
      if (release) {
        console.log(`  Release:      ${provenanceLine(release)}`);
        console.log(`  System changes: ${SYSTEM_CHANGES}`);
      }
      console.log(`  Apps:         ${installed} installed, ${running} running (${instances} instances, ${activities} activities)`);
      console.log(`  Toolchain:    ${toolchain}/bin (${toolchainBins} binaries)`);
      console.log(`  Base-Rootfs:  ${rootfs} (${dirSize(rootfs)})`);
      console.log(`  Apps-Dir:     ${appsDir}`);
      console.log(`  Data-Dir:     ${dataDir}`);
    });
}
