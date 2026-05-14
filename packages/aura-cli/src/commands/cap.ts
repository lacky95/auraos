import type { Command } from 'commander';
import { color, fail, info, ok, table } from '../lib/format.js';
import {
  ensureRegistry,
  installCapability,
  loadRegistry,
  loadState,
  removeCapability,
  saveRegistry,
  saveState,
  type CapabilityEntry,
} from '../lib/registry.js';
import { addToolToManifest, listAllManifests, removeToolFromManifest } from '../lib/manifest.js';
import { api } from '../lib/client.js';

export function registerCap(program: Command): void {
  const cap = program.command('cap').alias('capability').description('Manage shareable CLI capabilities (opt-in binaries bind-mounted into PRoot apps).');

  cap
    .command('list')
    .alias('ls')
    .option('--installed', 'Show only installed capabilities')
    .option('--available', 'Show only NOT installed capabilities')
    .description('List capabilities from the registry with install status and which apps declare them.')
    .action(async (opts: { installed?: boolean; available?: boolean }) => {
      ensureRegistry();
      const reg = loadRegistry();
      const state = loadState();
      const manifests = listAllManifests();
      const rows = Object.entries(reg.capabilities).map(([name, entry]) => {
        const installed = state.capabilities[name]?.installed === true || entry.source === 'builtin';
        const declaredBy = manifests
          .filter((m) => Array.isArray(m.tools) && m.tools.includes(name))
          .map((m) => m.id);
        return {
          NAME:    name,
          SOURCE:  entry.source,
          INSTALLED: installed ? color.green('✓') : color.dim('✗'),
          'DECLARED-BY': declaredBy.length ? declaredBy.join(',') : color.dim('-'),
        };
      })
      .filter((r) => {
        if (opts.installed)  return r.INSTALLED.includes('✓');
        if (opts.available)  return r.INSTALLED.includes('✗');
        return true;
      });
      console.log(table(rows, ['NAME', 'SOURCE', 'INSTALLED', 'DECLARED-BY']));
    });

  cap
    .command('install <name...>')
    .description('Install one or more capabilities (apt/npm/curl per registry entry) into the shared toolchain.')
    .action(async (names: string[]) => {
      ensureRegistry();
      const reg = loadRegistry();
      const state = loadState();
      for (const name of names) {
        const entry = reg.capabilities[name];
        if (!entry) { fail(`Unknown capability: ${name}. See \`aura cap registry show\`.`); }
        info(`Installing ${color.bold(name)} (source=${entry.source}) …`);
        const result = await installCapability(name, entry);
        state.capabilities[name] = { installed: true, installedAt: new Date().toISOString(), version: result.version ?? null };
        ok(`installed ${name} → ${result.symlink}`);
      }
      saveState(state);
    });

  cap
    .command('remove <name>')
    .description('Uninstall a capability + remove it from every app manifest that declares it.')
    .action(async (name: string) => {
      ensureRegistry();
      const reg = loadRegistry();
      const state = loadState();
      const entry = reg.capabilities[name];
      if (!entry) fail(`Unknown capability: ${name}`);
      await removeCapability(name, entry);
      delete state.capabilities[name];
      saveState(state);
      const affected: string[] = [];
      for (const m of listAllManifests()) {
        if (removeToolFromManifest(m.id, name)) affected.push(m.id);
      }
      ok(`removed ${name}` + (affected.length ? ` (revoked from: ${affected.join(', ')})` : ''));
    });

  cap
    .command('grant <appId> <name...>')
    .description('Add a capability to an app manifest. Restarts running instances so the bind-mount takes effect.')
    .action(async (appId: string, names: string[]) => {
      for (const name of names) {
        const changed = addToolToManifest(appId, name);
        if (changed) ok(`granted ${name} → ${appId}`);
        else info(`${name} already declared by ${appId}`);
      }
      await restartIfRunning(appId);
    });

  cap
    .command('revoke <appId> <name...>')
    .description('Remove a capability from an app manifest and restart running instances.')
    .action(async (appId: string, names: string[]) => {
      for (const name of names) {
        const changed = removeToolFromManifest(appId, name);
        if (changed) ok(`revoked ${name} from ${appId}`);
        else info(`${name} was not declared by ${appId}`);
      }
      await restartIfRunning(appId);
    });

  cap
    .command('info <name>')
    .description('Print registry entry + install status + apps declaring this capability.')
    .action(async (name: string) => {
      ensureRegistry();
      const reg = loadRegistry();
      const entry = reg.capabilities[name];
      if (!entry) fail(`Unknown capability: ${name}`);
      const state = loadState();
      const installed = state.capabilities[name];
      const declaredBy = listAllManifests().filter((m) => m.tools?.includes(name)).map((m) => m.id);
      console.log(color.bold(name));
      console.log(JSON.stringify({ registry: entry, installed: installed ?? false, declaredBy }, null, 2));
    });

  const registry = cap.command('registry').description('Inspect or edit the capabilities registry YAML.');
  registry
    .command('show')
    .description('Print the current registry contents.')
    .action(() => {
      ensureRegistry();
      console.log(JSON.stringify(loadRegistry(), null, 2));
    });
  registry
    .command('add <name>')
    .requiredOption('--source <type>', 'apt | npm | curl | builtin')
    .option('--package <pkg>',  'Package name (for apt or npm sources)')
    .option('--binary <bin>',   'Binary name to expose in /os/toolchain/bin/', '')
    .option('--url <url>',      'Download URL (for curl source)')
    .description('Add a new capability to the registry YAML.')
    .action((name: string, opts: { source: string; package?: string; binary?: string; url?: string }) => {
      ensureRegistry();
      const reg = loadRegistry();
      const entry: CapabilityEntry = { source: opts.source as CapabilityEntry['source'], binary: opts.binary || name };
      if (opts.package) entry.package = opts.package;
      if (opts.url)     entry.url = opts.url;
      reg.capabilities[name] = entry;
      saveRegistry(reg);
      ok(`added ${name} to registry`);
    });
  registry
    .command('remove <name>')
    .description('Remove a capability definition from the registry YAML.')
    .action((name: string) => {
      ensureRegistry();
      const reg = loadRegistry();
      delete reg.capabilities[name];
      saveRegistry(reg);
      ok(`removed ${name} from registry`);
    });
}

async function restartIfRunning(appId: string): Promise<void> {
  try {
    const dto = await api.get<{ instances: Array<{ instanceId: string }> }>(
      `/api/apps/${encodeURIComponent(appId)}/status`,
    );
    if (!dto.instances.length) return;
    info(`restarting ${dto.instances.length} running instance(s) of ${appId}`);
    await api.post(`/api/apps/${encodeURIComponent(appId)}/stop`);
    await api.post(`/api/apps/${encodeURIComponent(appId)}/start`);
  } catch (err) {
    info(`could not auto-restart ${appId}: ${(err as Error).message}`);
  }
}
