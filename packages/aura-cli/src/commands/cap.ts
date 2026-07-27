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
import { api } from '../lib/client.js';
import {
  promptChoice,
  promptMultiSelect,
  BACK,
  PromptCancelled,
  type MultiSelectMode,
} from '../lib/prompts.js';

interface ManifestLite { id: string; name?: string; tools?: string[] }
interface AppDto { manifest: ManifestLite }

/** The two special allowlist markers (see core's tool-allowlist). */
const WILDCARD = '*';   // grant ALL tools; overrides everything
const ALL_EXCEPT = '#'; // grant all tools EXCEPT the named ones; overridden by '*'

/**
 * Pull every installed app's manifest from the shell. Replaces the
 * filesystem-walking `listAllManifests()` so this CLI works from inside a
 * sliced container sandbox (Terminal etc.) where /workspace/apps only has
 * the calling app's own subdir bound. /api/apps is the canonical source
 * of truth and already returns the parsed manifest per app.
 */
async function fetchAllManifests(): Promise<ManifestLite[]> {
  const apps = await api.get<AppDto[]>('/api/apps');
  return apps.map((a) => a.manifest);
}

interface ManifestEditResult {
  ok?: boolean;
  changed?: boolean;
  refreshed?: string[];
  refreshError?: string;
  error?: string;
  message?: string;
}
async function editManifest(appId: string, action: 'add-tool' | 'remove-tool', tool: string): Promise<ManifestEditResult> {
  return api.post<ManifestEditResult>('/api/admin/manifest-edit', { appId, action, tool });
}

/** Replace an app's whole tools[] atomically (used by the interactive picker). */
async function setToolsManifest(appId: string, tools: string[]): Promise<ManifestEditResult> {
  return api.post<ManifestEditResult>('/api/admin/manifest-edit', { appId, action: 'set-tools', tools });
}

/** Human-readable summary of what a tools[] effectively grants, honoring the
 *  '*' (all) and '#' (all-except) markers with '*' taking precedence. */
function grantSummary(tools: string[]): string {
  const named = tools.filter((t) => t !== WILDCARD && t !== ALL_EXCEPT);
  if (tools.includes(WILDCARD)) {
    const kept = named.length ? color.dim(` (keeps: ${named.join(', ')})`) : '';
    return color.green('ALL tools') + color.dim(' via *') + kept;
  }
  if (tools.includes(ALL_EXCEPT)) {
    return color.green('ALL except') + ` ${named.join(', ') || '(none)'}` + color.dim(' via #');
  }
  return named.length ? named.join(', ') : color.dim('(none)');
}

/** Available tools = installed caps ∪ /os/toolchain/bin binaries, plus
 *  not-yet-installed registry caps (so the picker can surface them). */
async function gatherAvailableTools(): Promise<Array<{ name: string; installed: boolean; desc: string }>> {
  ensureRegistry();
  const reg = loadRegistry();
  const out = new Map<string, { installed: boolean; desc: string }>();
  try {
    const [capRes, toolsRes] = await Promise.all([
      api.get<{ state: { capabilities: Record<string, { installed: boolean }> } }>('/api/admin/cap'),
      api.get<{ storeEntries: string[] }>('/api/admin/inspect-tools'),
    ]);
    for (const n of toolsRes.storeEntries ?? []) {
      out.set(n, { installed: true, desc: reg.capabilities[n]?.description ?? 'system binary in /os/toolchain/bin' });
    }
    for (const [n, s] of Object.entries(capRes.state.capabilities)) {
      if (s.installed && !out.has(n)) out.set(n, { installed: true, desc: reg.capabilities[n]?.description ?? '' });
    }
  } catch {
    const state = loadState();
    for (const [n, s] of Object.entries(state.capabilities)) {
      if (s.installed) out.set(n, { installed: true, desc: reg.capabilities[n]?.description ?? '' });
    }
  }
  for (const [n, e] of Object.entries(reg.capabilities)) {
    if (e.source === 'builtin') out.set(n, { installed: true, desc: e.description ?? '' });
    else if (!out.has(n))       out.set(n, { installed: false, desc: e.description ?? '' });
  }
  return [...out.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Interactive tool-grant picker (`aura cap grant` with no tool names). Mirrors
 * the `aura dev new` wizard's multi-select. Flow: pick ONE app (unless given) →
 * check/uncheck tools, with the app's current grants pre-checked → the two
 * special markers `*` (all) and `#` (all-except) are just extra checkboxes that
 * coexist with the named selection. The full checked set (markers included) is
 * persisted so unchecking a marker restores the underlying list. `*` overrides
 * `#`; both override the named list for the EFFECTIVE grant.
 */
async function grantInteractive(appIdArg?: string): Promise<void> {
  const manifests = await fetchAllManifests();
  if (manifests.length === 0) fail('No installed apps to grant to.');

  // 1 — pick the target app (skip if one was passed on the CLI).
  let appId = appIdArg;
  if (!appId) {
    const choices = manifests
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((m) => ({ value: m.id, label: m.id, desc: grantSummary(m.tools ?? []) }));
    const picked = await promptChoice<string>('Grant tools to which app?', choices, 0, { allowBack: true });
    if (picked === BACK) { info('cancelled'); return; }
    appId = picked;
  }
  const manifest = manifests.find((m) => m.id === appId);
  if (!manifest) fail(`App not installed: ${appId}`);
  const current = manifest!.tools ?? [];
  const currentSet = new Set(current);

  // 2 — build the checkbox list: two marker rows first, then every tool.
  const available = await gatherAvailableTools();
  const markerOptions = [
    {
      value: WILDCARD,
      label: `${WILDCARD}  (all tools)`,
      desc: 'Grant every tool. Overrides everything below.',
      tag: color.magenta('wildcard'),
      initiallyChecked: currentSet.has(WILDCARD),
    },
    {
      value: ALL_EXCEPT,
      label: `${ALL_EXCEPT}  (all except checked)`,
      desc: 'Grant everything EXCEPT the tools checked below. Ignored when * is checked.',
      tag: color.magenta('deny-list'),
      initiallyChecked: currentSet.has(ALL_EXCEPT),
    },
  ];
  const toolOptions = available.map((t) => ({
    value: t.name,
    label: t.name,
    desc: t.desc,
    tag: currentSet.has(t.name)
      ? color.green('granted')
      : (t.installed ? color.dim('installed') : color.yellow('not installed')),
    initiallyChecked: currentSet.has(t.name),
  }));
  // Any named tools already in the manifest that aren't in the available set
  // (e.g. a tool no longer installed) — keep them checkable so we don't drop them.
  for (const t of current) {
    if (t === WILDCARD || t === ALL_EXCEPT) continue;
    if (!available.some((a) => a.name === t)) {
      toolOptions.push({ value: t, label: t, desc: '', tag: color.green('granted'), initiallyChecked: true });
    }
  }

  const modes: MultiSelectMode<string>[] = [
    { label: 'grant', options: [...markerOptions, ...toolOptions] },
  ];
  const raw = await promptMultiSelect<string>(`Tools for ${color.bold(appId!)}`, modes, 0, { allowBack: true });
  if (raw === BACK) { info('cancelled'); return; }
  const selected = raw.selected;

  // 3 — persist the full selection (markers included) and report.
  const before = [...currentSet].sort().join(',');
  const after = [...new Set(selected)].sort().join(',');
  if (before === after) { info(`no change — ${appId} already grants: ${grantSummary(current)}`); return; }

  const r = await setToolsManifest(appId!, selected);
  if (!r.ok) fail(`grant → ${appId} failed: ${r.error ?? 'unknown'} ${r.message ?? ''}`.trim());
  ok(`updated ${appId}${r.refreshError ? color.yellow(` (refresh: ${r.refreshError})`) : ''}`);
  info(`effective grant: ${grantSummary(selected)}`);
  if (selected.includes(WILDCARD) && selected.some((t) => t !== WILDCARD && t !== ALL_EXCEPT)) {
    info(color.dim('  (* overrides the named list, but the list is kept for when you uncheck *)'));
  }
}

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
      const manifests = await fetchAllManifests();
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
      // Strip the cap from every manifest that still declares it. Routes
      // through the shell so we cross sliced-bind sandboxes correctly.
      const affected: string[] = [];
      for (const m of await fetchAllManifests()) {
        if (!m.tools?.includes(name)) continue;
        const r = await editManifest(m.id, 'remove-tool', name);
        if (r.changed) affected.push(m.id);
      }
      ok(`removed ${name}` + (affected.length ? ` (revoked from: ${affected.join(', ')})` : ''));
    });

  cap
    .command('grant [appId] [name...]')
    .option('-i, --interactive', 'Open the interactive tool picker (TUI)')
    .description(
      "Grant capabilities to an app. With tool names: adds them (use '*' for all, " +
      "'#' for all-except). With no names (or -i): opens an interactive picker to " +
      'check/uncheck tools, showing what is already granted. Hot-refreshes running ' +
      'instances — no respawn.',
    )
    .action(async (appId: string | undefined, names: string[], opts: { interactive?: boolean }) => {
      // Interactive when explicitly asked, or when no tool names were given
      // (with or without an appId — a bare appId opens the picker for that app).
      if (opts.interactive || names.length === 0) {
        try {
          await grantInteractive(appId);
        } catch (err) {
          if (err instanceof PromptCancelled) { info('cancelled'); return; }
          throw err;
        }
        return;
      }
      // Non-interactive: append each named tool/marker (back-compat path).
      // Route through the shell so it works from any sandbox (the local
      // /workspace/apps bind only covers the caller's own app in container
      // sandboxes). The endpoint also triggers refreshInstanceTools.
      if (!appId) fail('Missing appId. Pass an app id, or run with no args for the picker.');
      for (const name of names) {
        const r = await editManifest(appId!, 'add-tool', name);
        if (!r.ok)            fail(`grant ${name} → ${appId} failed: ${r.error ?? 'unknown'} ${r.message ?? ''}`.trim());
        if (r.changed)        ok(`granted ${name} → ${appId}${r.refreshError ? color.yellow(` (refresh: ${r.refreshError})`) : ''}`);
        else                  info(`${name} already declared by ${appId}`);
      }
    });

  cap
    .command('revoke <appId> <name...>')
    .description('Remove a capability from an app manifest and restart running instances.')
    .action(async (appId: string, names: string[]) => {
      for (const name of names) {
        const r = await editManifest(appId, 'remove-tool', name);
        if (!r.ok)            fail(`revoke ${name} from ${appId} failed: ${r.error ?? 'unknown'} ${r.message ?? ''}`.trim());
        if (r.changed)        ok(`revoked ${name} from ${appId}${r.refreshError ? color.yellow(` (refresh: ${r.refreshError})`) : ''}`);
        else                  info(`${name} was not declared by ${appId}`);
      }
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
      // Pull manifests via the shell so sliced-bind sandboxes see every
      // installed app, not just the calling one.
      const manifests = await fetchAllManifests();
      const declaredBy = manifests.filter((m) => m.tools?.includes(name)).map((m) => m.id);
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
