/**
 * `aura runtime` (Phase 5 stream R, ARI §5.1, D75): the runtimes apps run
 * in, the Runtime Settings and the per-installation overrides. Shell route:
 * `/api/admin/runtimes/**` (shell lib/runtimes.ts). Reads answer directly;
 * every change is the owner's with the password (`fresh`): from the System
 * Terminal the owner confirms it in the desktop, on the host it acts
 * directly. A change applies to the next start of an app.
 *
 *   aura runtime ls                         the runtimes: enabled, default, health, instances
 *   aura runtime show <id>                  capabilities, settings (with their schema), apps on it
 *   aura runtime set <id> <key>=<value>…    change settings (validated against the schema)
 *   aura runtime enable|disable <id>        disable: --stop-instances when instances run
 *   aura runtime default [<id>]             show or set the default for apps that name none
 *   aura runtime check <id> [--app <app>] [--need jump,mount,closed]   would it run there? (read-only)
 *   aura runtime override ls|rm <app>       the overrides (migration or owner); rm: next start without it
 *   aura runtime migrate [--adopt-default <app> | --keep <app> <runtime>]   the open D75 decisions
 */
import type { Command } from 'commander';
import { api, type ShellError } from '../lib/client.js';
import { color, fail, ok, table } from '../lib/format.js';

const ROUTE = '/api/admin/runtimes';

type SettingsField = { type: string; title: string; description?: string; default?: unknown; enum?: string[] };
export interface RuntimeView {
  id: string; title: string; description: string; builtIn: boolean; alwaysEnabled: boolean; enabled: boolean; isDefault: boolean;
  settingsSchema: { properties: Record<string, SettingsField> };
  settings: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  /** D100 §12 (5b): technical feasibility; absent from an older shell. */
  features?: Array<{ id: string; support: 'supported' | 'conditional' | 'unsupported'; applyMode?: string; constraints?: Record<string, unknown> }>;
  health: { status: 'ok' | 'unavailable'; detail?: string };
  instances: Array<{ instanceId: string; appId: string; state: string; source?: string }>;
}
export interface InstallationView {
  appId: string; installationId: string | null; sandbox: 'explicit' | 'omitted';
  runtime: string | null; source: string | null; error?: { code: string; message: string };
}
export interface OverrideView { installationId: string; appId?: string; runtime: string; source: string; legacy?: string; recordedAt: string; settings?: Record<string, unknown> }
export interface PendingView { installationId: string; appId: string; legacy: string; reason: string; sandbox: string; recordedAt: string }
export interface RuntimesState {
  default: string; trusted: boolean; useProotEnv: string | null;
  runtimes: RuntimeView[]; installations: InstallationView[]; overrides: OverrideView[]; pending: PendingView[];
  migration: { d75: string | null };
}

/** Human labels for the capability table (Settings shows the same). */
export const CAPABILITY_LABELS: Record<string, string> = {
  isolation: 'Isolation',
  network: 'Network',
  appHome: 'App Home',
  privateHomeSession: 'Private Home in jump',
  sessionExec: 'Isolated jump session',
  identity: 'Per-app identities',
  readOnlyBinds: 'Read-only binds (closed apps)',
  hostFilesystem: 'Host filesystem',
  mounts: 'Cross-app mounts',
  idmappedMounts: 'Writable cross-uid mounts',
  portExpose: 'Port expose',
  sidecars: 'Sidecars',
  warmPool: 'Warm pool',
  survivesShellRestart: 'Survives a shell restart',
  usage: 'Usage metering',
  gpu: 'GPU',
};

/** A feature row for people: support, how a change applies, its constraints. */
export function featureText(f: NonNullable<RuntimeView['features']>[number]): string {
  const support = f.support === 'supported' ? color.green('supported') : f.support === 'conditional' ? color.yellow('conditional') : color.dim('unsupported');
  const extra = [f.applyMode, ...Object.entries(f.constraints ?? {}).map(([k, v]) => `${k}=${String(v)}`)].filter(Boolean);
  return extra.length ? `${support} ${color.dim(`(${extra.join(', ')})`)}` : support;
}

/** A capability value for people: booleans as yes/no, with the fail-closed note. */
export function capabilityText(key: string, v: unknown): string {
  if (v === true) return 'yes';
  if (v === false) return key === 'privateHomeSession' || key === 'sessionExec' || key === 'readOnlyBinds' ? 'no, fails closed' : 'no';
  return String(v);
}

/** `key=value` arguments to a settings object; values stay strings (the schema parses them). */
export function parseAssignments(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args) {
    const i = a.indexOf('=');
    if (i <= 0) throw new Error(`expected <key>=<value>, got: ${a}`);
    out[a.slice(0, i)] = a.slice(i + 1);
  }
  return out;
}

export function runtimeRows(s: RuntimesState): Array<Record<string, string>> {
  return s.runtimes.map((r) => ({
    RUNTIME: r.id,
    ENABLED: r.enabled ? color.green('yes') : color.yellow('no'),
    DEFAULT: r.isDefault ? color.bold('*') : '',
    HEALTH: r.health.status === 'ok' ? 'ok' : color.yellow('unavailable'),
    APPS: String(s.installations.filter((i) => i.runtime === r.id && !i.error).length),
    INSTANCES: String(r.instances.length),
    TITLE: r.title,
  }));
}

function refusal(err: unknown): string {
  const body = (err as ShellError).body;
  if (body) {
    try {
      const b = JSON.parse(body) as { message?: string; error?: string };
      return b.message ?? b.error ?? body;
    } catch { return body; }
  }
  return (err as Error).message;
}

async function state(): Promise<RuntimesState> {
  return api.get<RuntimesState>(ROUTE);
}

function runtimeOf(s: RuntimesState, id: string): RuntimeView {
  const r = s.runtimes.find((x) => x.id === id);
  if (!r) fail(`runtime ${id} is not installed. Installed: ${s.runtimes.map((x) => x.id).join(', ')}`);
  return r;
}

async function ls(json: boolean): Promise<void> {
  const s = await state();
  if (json) { console.log(JSON.stringify(s, null, 2)); return; }
  console.log(table(runtimeRows(s)));
  if (!s.trusted) console.log(color.dim('\nRuntime Settings: built-in defaults (nothing stored yet).'));
  if (s.overrides.length) console.log(`\n${s.overrides.length} override(s): aura runtime override ls`);
  if (s.pending.length) {
    console.log(color.yellow(`\n${s.pending.length} app(s) wait for a runtime migration decision and do not start: aura runtime migrate`));
  }
}

async function show(id: string): Promise<void> {
  const s = await state();
  const r = runtimeOf(s, id);
  console.log(`${color.bold(r.title)} (${r.id})${r.isDefault ? color.dim('  · the default') : ''}`);
  console.log(color.dim(r.description));
  console.log(`enabled:   ${r.enabled ? color.green('yes') : color.yellow('no')}${r.alwaysEnabled ? color.dim(' (always)') : ''}`);
  console.log(`health:    ${r.health.status === 'ok' ? 'ok' : color.yellow(`unavailable: ${r.health.detail ?? ''}`)}`);
  if (r.id === 'proot') console.log(`AURA_USE_PROOT: ${s.useProotEnv ?? color.dim('(unset)')} ${color.dim('(on the container, read-only)')}`);
  console.log('\ncapabilities:');
  for (const [k, v] of Object.entries(r.capabilities)) console.log(`  ${(CAPABILITY_LABELS[k] ?? k).padEnd(30)} ${capabilityText(k, v)}`);
  if (r.features?.length) {
    console.log(`\nfeatures ${color.dim('(what it can do technically; grants and permissions still decide)')}:`);
    for (const f of r.features) console.log(`  ${f.id.padEnd(30)} ${featureText(f)}`);
  }
  const fields = Object.entries(r.settingsSchema.properties);
  console.log('\nsettings:');
  if (!fields.length) console.log(color.dim('  (none)'));
  for (const [k, f] of fields) {
    console.log(`  ${k} = ${JSON.stringify(r.settings[k] ?? null)}${f.enum ? color.dim(`  (${f.enum.join(' | ')})`) : ''}`);
    if (f.description) console.log(color.dim(`      ${f.description}`));
  }
  const apps = s.installations.filter((i) => i.runtime === r.id);
  console.log('\napps:');
  if (!apps.length) console.log(color.dim('  (none)'));
  for (const a of apps) console.log(`  ${a.appId.padEnd(36)} ${a.error ? color.yellow(a.error.message) : color.dim(a.source ?? '')}`);
  if (r.instances.length) console.log(`\ninstances: ${r.instances.map((i) => i.instanceId).join(', ')}`);
}

/** An app id or an installation id to the override or decision it names. */
function byApp<T extends { installationId: string; appId?: string }>(list: T[], ref: string): T | undefined {
  return list.find((o) => o.installationId === ref || o.appId === ref);
}

async function change<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (err) { fail(`${what}: ${refusal(err)}`); }
}

export function registerRuntime(program: Command): void {
  const rt = program
    .command('runtime')
    .description('The runtimes apps run in (container, PRoot), the default for apps that name none, their settings and the per-installation overrides.')
    .addHelpText('after', [
      '',
      'Changes need your password (the desktop asks; on the host they act directly) and apply to the next start of an app.',
      'Settings → Runtimes shows the same.',
      '',
      'Examples:',
      '  aura runtime ls',
      '  aura runtime show proot',
      '  aura runtime default container',
      '  aura runtime check proot --app io.example.notes',
      '  aura runtime migrate --adopt-default io.example.old',
    ].join('\n'));

  rt.command('ls').description('List the runtimes: enabled, default, health, apps and instances.')
    .option('-o, --output <fmt>', 'table | json', 'table')
    .action(async (o: { output: string }) => ls(o.output === 'json'));

  rt.command('show <id>').description('One runtime: capabilities, settings (with their schema) and the apps on it.')
    .action(async (id: string) => show(id));

  rt.command('set <id> <assignments...>').description('Change a runtime\'s settings: <key>=<value> (validated against its schema).')
    .action(async (id: string, assignments: string[]) => {
      let settings: Record<string, string>;
      try { settings = parseAssignments(assignments); } catch (err) { fail((err as Error).message); }
      const r = await change('set', () => api.put<{ changed: boolean; settings: Record<string, unknown> }>(`${ROUTE}/${encodeURIComponent(id)}/settings`, { settings }));
      ok(r.changed ? `${id}: ${JSON.stringify(r.settings)} (applies to new starts)` : `${id}: unchanged`);
    });

  rt.command('enable <id>').description('Enable a runtime.')
    .action(async (id: string) => {
      const r = await change('enable', () => api.post<{ changed: boolean }>(`${ROUTE}/${encodeURIComponent(id)}/enable`));
      ok(r.changed ? `${id} enabled` : `${id} was enabled`);
    });

  rt.command('disable <id>').description('Disable a runtime. Apps on it stay installed and fail to start with "runtime disabled"; nothing moves.')
    .option('--stop-instances', 'Also stop the instances running on it (otherwise refused while any run)')
    .action(async (id: string, o: { stopInstances?: boolean }) => {
      const r = await change('disable', () => api.post<{ changed: boolean; stopped?: string[] }>(`${ROUTE}/${encodeURIComponent(id)}/disable`, { stopInstances: Boolean(o.stopInstances) }));
      ok(`${id} ${r.changed ? 'disabled' : 'was disabled'}${r.stopped?.length ? `; stopped ${r.stopped.join(', ')}` : ''}`);
    });

  rt.command('default [id]').description('Show the default runtime, or set it (it must be enabled).')
    .action(async (id?: string) => {
      if (!id) { console.log((await state()).default); return; }
      const r = await change('default', () => api.put<{ changed: boolean; default: string }>(`${ROUTE}/default`, { runtime: id }));
      ok(r.changed ? `default runtime: ${r.default} (apps that name none start on it from their next start)` : `default runtime is ${r.default}`);
    });

  rt.command('check <id>').description('Would it run there? A read-only capability check: an app\'s needs and/or named needs.')
    .option('--app <appId>', 'What this app\'s manifest needs')
    .option('--need <list>', 'jump, home-private|app|ephemeral, mount, idmap-mount, closed, sidecars, port-expose, host-filesystem or capability names (comma-separated)')
    .option('-o, --output <fmt>', 'text | json', 'text')
    .action(async (id: string, o: { app?: string; need?: string; output: string }) => {
      const needs = o.need ? o.need.split(',').map((s) => s.trim()).filter(Boolean) : [];
      const r = await change('check', () => api.post<{ ok: boolean; missing: string[]; suggest?: string[]; unavailable?: string; enabled: boolean }>(`${ROUTE}/check`, {
        runtime: id, ...(o.app ? { appId: o.app } : {}), needs,
      }));
      if (o.output === 'json') { console.log(JSON.stringify(r, null, 2)); return; }
      if (r.ok) { ok(`${id}: yes`); return; }
      const why = [
        ...(r.missing.length ? [`capability-missing: ${r.missing.map((m) => CAPABILITY_LABELS[m] ?? m).join(', ')}`] : []),
        // D73: named only, never picked.
        ...(r.missing.length && r.suggest ? [r.suggest.length ? `it could run on: ${r.suggest.join(', ')}` : 'no installed runtime can run it'] : []),
        ...(!r.enabled ? ['disabled'] : []),
        ...(r.unavailable ? [`unavailable: ${r.unavailable}`] : []),
      ];
      console.log(`${color.yellow('no')}: ${why.join('; ')}`);
      process.exitCode = 1;
    });

  const ov = rt.command('override').description('Per-installation runtime overrides (D75 migration or the owner\'s).');
  ov.command('ls').description('List the overrides.').action(async () => {
    const s = await state();
    if (!s.overrides.length) { console.log(color.dim('(no overrides)')); return; }
    console.log(table(s.overrides.map((o) => ({
      APP: o.appId ?? '-', RUNTIME: `${o.runtime}${o.settings?.['placement'] ? `/${String(o.settings['placement'])}` : ''}`,
      SOURCE: o.source, LEGACY: o.legacy ?? '-', SINCE: o.recordedAt.slice(0, 10), INSTALLATION: o.installationId,
    }))));
  });
  ov.command('rm <app>').description('Remove an app\'s override (app id or installation id): its next start follows its manifest or the default.')
    .action(async (ref: string) => {
      const s = await state();
      const o = byApp(s.overrides, ref);
      if (!o) fail(`no runtime override for ${ref}`);
      await change('override rm', () => api.del(`${ROUTE}/overrides/${encodeURIComponent(o.installationId)}`));
      ok(`removed the ${o.source} override of ${o.appId ?? o.installationId} (${o.runtime}); applies at its next start`);
    });

  rt.command('migrate').description('The open runtime migration decisions (D75): apps that do not start until you decide.')
    .option('--adopt-default <app>', 'Run the app on the default runtime (recommended)')
    .option('--keep <app>', 'Keep the app on a runtime it can run on securely (open apps only); give the runtime as the argument')
    .argument('[runtime]', 'With --keep: the runtime (e.g. proot)')
    .action(async (runtime: string | undefined, o: { adoptDefault?: string; keep?: string }) => {
      if (o.adoptDefault && o.keep) fail('either --adopt-default or --keep');
      if (o.adoptDefault || o.keep) {
        const appId = (o.adoptDefault ?? o.keep)!;
        if (o.keep && !runtime) fail('--keep <app> <runtime>, e.g. --keep io.example.app proot');
        const r = await change('migrate', () => api.post<{ runtime: string }>(`${ROUTE}/migrate`, {
          appId, decision: o.keep ? 'keep' : 'adopt-default', ...(o.keep ? { runtime } : {}),
        }));
        ok(`${appId} runs on ${r.runtime} from its next start (installation, data and permissions unchanged)`);
        return;
      }
      const s = await state();
      if (!s.pending.length) { ok(s.migration.d75 ? `no decision open (migration recorded ${s.migration.d75.slice(0, 10)})` : 'no decision open'); return; }
      console.log(table(s.pending.map((p) => ({ APP: p.appId, LEGACY: p.legacy, REASON: p.reason, SANDBOX: p.sandbox }))));
      console.log('\nDecide each (they do not start until then):');
      for (const p of s.pending) {
        console.log(`  aura runtime migrate --adopt-default ${p.appId}     ${color.dim('# container, recommended')}`);
        if (p.reason === 'master-direct') console.log(`  aura runtime migrate --keep ${p.appId} proot      ${color.dim('# open apps only')}`);
      }
    });
}
