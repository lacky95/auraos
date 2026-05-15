import type { Command } from 'commander';
import { color, fail, info, ok, table } from '../lib/format.js';
import {
  ensureRegistry,
  loadRegistry,
  loadState,
  saveRegistry,
  type CapabilityEntry,
  type State,
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
      // Prefer the shell's view of state (it's the writer; when this CLI runs
      // inside a PRoot the local /data bind has shown stale reads in practice).
      // Fall back to the local file if the shell is unreachable so `cap list`
      // still works from a host shell with the server stopped.
      let state: State;
      try {
        const remote = await api.get<{ state: State }>('/api/admin/cap');
        state = remote.state;
      } catch {
        state = loadState();
      }
      const manifests = listAllManifests();
      const rows = Object.entries(reg.capabilities).map(([name, entry]) => {
        const installed = state.capabilities[name]?.installed === true || entry.source === 'builtin';
        // An app with `*` in tools[] gets every installed cap bound at spawn
        // time (see ProotRunner.buildArgs). Surface that here as a normal
        // grant for installed caps so DECLARED-BY reflects the real bind set.
        const declaredBy = manifests
          .filter((m) => Array.isArray(m.tools) && (m.tools.includes(name) || (installed && m.tools.includes('*'))))
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
      // Always route install through the shell. The CLI is most often invoked
      // from inside a PRoot terminal where apt-key/gnupg are unavailable and
      // /os/toolchain isn't bind-mounted — letting the shell do it sidesteps
      // both, and keeps a single source of truth for toolchain state.
      for (const name of names) {
        const entry = reg.capabilities[name];
        if (!entry) { fail(`Unknown capability: ${name}. See \`aura cap registry show\`.`); }
        info(`Installing ${color.bold(name)} (source=${entry.source}) via shell …`);
        const res = await api.post<{ ok: boolean; symlink?: string; version?: string | null; error?: string }>(
          '/api/admin/cap',
          { action: 'install', name, entry },
        );
        if (!res?.ok) fail(`install ${name} failed: ${res?.error ?? 'unknown error'}`);
        ok(`installed ${name} → ${res.symlink}${res.version ? ` (${res.version})` : ''}`);
      }
    });

  cap
    .command('remove <name>')
    .description('Uninstall a capability + remove it from every app manifest that declares it.')
    .action(async (name: string) => {
      ensureRegistry();
      const reg = loadRegistry();
      const entry = reg.capabilities[name];
      if (!entry) fail(`Unknown capability: ${name}`);
      const res = await api.post<{ ok: boolean; error?: string }>(
        '/api/admin/cap',
        { action: 'remove', name, entry },
      );
      if (!res?.ok) fail(`remove ${name} failed: ${res?.error ?? 'unknown error'}`);
      const affected: string[] = [];
      for (const m of listAllManifests()) {
        if (removeToolFromManifest(m.id, name)) affected.push(m.id);
      }
      ok(`removed ${name}` + (affected.length ? ` (revoked from: ${affected.join(', ')})` : ''));
    });

  cap
    .command('grant <appId> <name...>')
    .description("Add a capability to an app manifest. Use '*' (quote it: \"'*'\") to auto-bind every installed cap, including future ones. Hot-refreshes running instances — no respawn.")
    .action(async (appId: string, names: string[]) => {
      let anyChange = false;
      for (const name of names) {
        const changed = addToolToManifest(appId, name);
        if (changed) { ok(`granted ${name} → ${appId}`); anyChange = true; }
        else info(`${name} already declared by ${appId}`);
      }
      if (anyChange) await refreshRunning(appId);
    });

  cap
    .command('revoke <appId> <name...>')
    .description('Remove a capability from an app manifest and restart running instances.')
    .action(async (appId: string, names: string[]) => {
      let anyChange = false;
      for (const name of names) {
        const changed = removeToolFromManifest(appId, name);
        if (changed) { ok(`revoked ${name} from ${appId}`); anyChange = true; }
        else info(`${name} was not declared by ${appId}`);
      }
      if (anyChange) await refreshRunning(appId);
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

/**
 * Hot-refresh every running instance of `appId` so it sees the updated
 * manifest tools[] without a backend respawn. The shell rewrites the
 * per-instance /aura/my-tools allowlist dir; PRoot's directory bind makes
 * the new symlinks visible to the running shell on the next PATH lookup.
 */
async function refreshRunning(appId: string): Promise<void> {
  try {
    const res = await api.post<{ ok: boolean; refreshed?: string[]; error?: string }>(
      '/api/admin/cap-refresh',
      { appId },
    );
    if (!res?.ok) {
      info(`hot-refresh skipped: ${res?.error ?? 'unknown error'}`);
      return;
    }
    const n = res.refreshed?.length ?? 0;
    if (n > 0) info(`hot-refreshed ${n} running instance(s) of ${appId} — no respawn needed`);
  } catch (err) {
    info(`hot-refresh failed: ${(err as Error).message} (manifest is updated; affected apps will pick it up on next launch)`);
  }
}
