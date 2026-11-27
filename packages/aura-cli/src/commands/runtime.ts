/**
 * `aura runtime` (Phase 5 stream R, ARI §5.1, D75): the runtimes apps run
 * in, the Runtime Settings and the per-installation overrides. Shell route:
 * `/api/admin/runtimes/**` (shell lib/runtimes.ts). Reads answer directly;
 * every change is the owner's with the password (`fresh`): from the System
 * Terminal the owner confirms it in the desktop, on the host it acts
 * directly. A change applies to the next start of an app.
 *
 *   aura runtime ls                         the runtimes: version, enabled, default, health, instances
 *   aura runtime show <id>                  version, ARI, health checks, every capability (and the
 *                                           feature view when the shell serves it), settings (with
 *                                           their schema), apps on it, instances on older settings
 *   aura runtime set <id> <key>=<value>…    change settings (validated against the schema)
 *   aura runtime enable|disable <id>        disable: --stop-instances when instances run
 *   aura runtime default [<id>]             show or set the default for apps that name none
 *   aura runtime check <id> [--app <app>] [--need jump,mount,closed]   would it run there? (read-only)
 *   aura runtime override ls|rm <app>       the overrides (migration or owner); rm: next start without it
 *   aura runtime override set <app> <runtime> [k=v…]   the owner's override (ARI-3), capability-checked
 *   aura runtime migrate [--adopt-default <app> | --keep <app> <runtime>]   the open D75 decisions
 *   aura runtime migrate --report [-o json] the D75 report, read-only: the dry-run classification,
 *                                           the recorded state and what a start does now
 */
import type { Command } from 'commander';
import { api, type ShellError } from '../lib/client.js';
import { color, fail, ok, table } from '../lib/format.js';

const ROUTE = '/api/admin/runtimes';

type SettingsField = { type: string; title: string; description?: string; default?: unknown; enum?: string[] };
/**
 * A feature of the derived feature view (D100 §12; the K addendum serves it):
 * feasibility only. Capabilities and permissions stay the one authorization
 * gate; both must hold.
 */
export interface FeatureView {
  id: string; support: 'supported' | 'conditional' | 'unsupported';
  applyMode?: 'live' | 'restart-required' | 'recreate-required'; constraints?: Record<string, string | number | boolean>;
}
export interface RuntimeView {
  id: string; title: string; description: string; builtIn: boolean; alwaysEnabled: boolean; enabled: boolean; isDefault: boolean;
  version?: string; ari?: number; settingsVersion?: number;
  settingsSchema: { properties: Record<string, SettingsField> };
  settings: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  features?: FeatureView[];
  health: { status: 'ok' | 'degraded' | 'unavailable'; detail?: string; checks?: Array<{ id: string; ok: boolean; detail?: string }> };
  instances: Array<{ instanceId: string; appId: string; state: string; source?: string; restartToApply?: boolean }>;
  restartToApply?: number;
}
export interface InstallationView {
  appId: string; installationId: string | null; sandbox: 'explicit' | 'omitted';
  runtime: string | null; source: string | null; needs?: string[]; override?: boolean;
  error?: { code: string; message: string; category?: string; missing?: string[]; suggest?: string[] };
}
export interface MigrationReportView {
  d75: string | null;
  env: { useProotEnv?: string; rootfsPresent: boolean };
  installations: Array<{
    appId: string; installationId: string | null; sandbox: string; legacy: string; decision: string; reason: string;
    override: OverrideView | null; pending: PendingView | null;
    current: { runtime: string | null; source: string | null; error?: { code: string; message: string; category?: string } };
  }>;
  reports: Array<{ file: string; recordedAt: string | null; installations: number; counts: Record<string, number>; error?: string }>;
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

/**
 * Capabilities a request can need (core `RUNTIME_BOOLEAN_CAPABILITIES` minus
 * the two that are facts, never needs): `false` means such a request fails
 * closed, never a weaker substitute.
 */
const NEVER_NEEDED = new Set(['survivesShellRestart', 'usage']);

/** A capability value for people: booleans as yes/no, with the fail-closed note. */
export function capabilityText(key: string, v: unknown): string {
  if (v === true) return 'yes';
  if (v === false) return NEVER_NEEDED.has(key) ? 'no' : 'no, fails closed';
  return String(v);
}

/** A feature row for people (D100 §12): support, how a change applies, constraints. Advisory is never shown as enforced. */
export function featureText(f: FeatureView): string {
  const c = Object.entries(f.constraints ?? {}).map(([k, v]) => `${k}: ${String(v)}`);
  return [f.support, ...(f.applyMode ? [f.applyMode] : []), ...c].join(', ');
}

/**
 * What kind of "no" a refusal is (D100 §17), from its standard `category`
 * when the shell sends one, else from the code: not authorized, not
 * supported, temporarily failed, restart required, not yet applied.
 */
export function refusalKind(b: { category?: string; error?: string; code?: string }): string | null {
  const c = (b.category ?? '').toUpperCase();
  if (c === 'PERMISSION_DENIED') return 'not authorized';
  if (c === 'UNSUPPORTED_FEATURE' || c === 'UNSUPPORTED_OPERATION') return 'not supported';
  if (c === 'RUNTIME_UNAVAILABLE' || c === 'OPERATION_TIMEOUT' || c === 'RESOURCE_EXHAUSTED' || c === 'CONFLICT') return 'temporarily failed';
  if (c === 'RESTART_REQUIRED' || c === 'RECREATE_REQUIRED') return 'restart required';
  if (c === 'PROVISIONING_FAILED' || c === 'ENFORCEMENT_FAILED') return 'not applied';
  const code = b.code ?? b.error;
  if (code === 'capability-missing' || code === 'runtime-not-installed' || code === 'runtime-disabled') return 'not supported';
  if (code === 'owner-required' || code === 'cancelled' || code === 'unauthenticated') return 'not authorized';
  if (code === 'conflict') return 'temporarily failed';
  return null;
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
    VERSION: r.version ?? '-',
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
      const b = JSON.parse(body) as { message?: string; error?: string; category?: string; code?: string };
      const kind = refusalKind(b);
      return `${b.message ?? b.error ?? body}${kind ? ` (${kind})` : ''}`;
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
  console.log(`version:   ${r.version ?? '-'}  ${color.dim(`ARI ${r.ari ?? '-'} · settings v${r.settingsVersion ?? '-'}`)}`);
  console.log(`enabled:   ${r.enabled ? color.green('yes') : color.yellow('no')}${r.alwaysEnabled ? color.dim(' (always)') : ''}`);
  console.log(`health:    ${r.health.status === 'ok' ? 'ok' : color.yellow(`${r.health.status}${r.health.detail ? `: ${r.health.detail}` : ''}`)}`);
  for (const c of r.health.checks ?? []) console.log(`  ${c.ok ? color.green('ok ') : color.yellow('no ')} ${c.id}${c.detail ? color.dim(`  ${c.detail}`) : ''}`);
  if (r.id === 'proot') console.log(`AURA_USE_PROOT: ${s.useProotEnv ?? color.dim('(unset)')} ${color.dim('(on the container, read-only)')}`);
  console.log('\ncapabilities:');
  for (const [k, v] of Object.entries(r.capabilities)) console.log(`  ${(CAPABILITY_LABELS[k] ?? k).padEnd(30)} ${capabilityText(k, v)}`);
  if (r.features?.length) {
    console.log(`\nfeatures ${color.dim('(feasibility; capabilities and permissions still decide)')}:`);
    for (const f of r.features) console.log(`  ${f.id.padEnd(30)} ${f.support === 'supported' ? featureText(f) : color.yellow(featureText(f))}`);
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
  for (const a of apps) {
    const needs = a.needs?.length ? color.dim(`  needs ${a.needs.join(', ')}`) : '';
    console.log(`  ${a.appId.padEnd(36)} ${a.error ? color.yellow(a.error.message) : color.dim(a.source ?? '')}${needs}`);
  }
  if (r.instances.length) console.log(`\ninstances: ${r.instances.map((i) => `${i.instanceId}${i.restartToApply ? color.yellow(' (restart to apply)') : ''}`).join(', ')}`);
  if (r.restartToApply) console.log(color.yellow(`${r.restartToApply} instance(s) run on older settings or another runtime: restart them to apply.`));
}

/** An app id or an installation id to the override or decision it names. */
function byApp<T extends { installationId: string; appId?: string }>(list: T[], ref: string): T | undefined {
  return list.find((o) => o.installationId === ref || o.appId === ref);
}

async function change<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (err) { fail(`${what}: ${refusal(err)}`); }
}

/** The report's rows for people: legacy vs now, and why (the recorded override, the open decision, the source). */
export function reportRows(r: MigrationReportView): Array<Record<string, string>> {
  return r.installations.map((i) => ({
    APP: i.appId,
    SANDBOX: i.sandbox,
    BEFORE: i.legacy,
    D75: i.decision,
    RECORDED: i.pending ? `decision open (${i.pending.reason})` : i.override ? `${i.override.source} → ${i.override.runtime}` : '-',
    NOW: i.current.error ? color.yellow(`${i.current.runtime ?? '?'}: ${i.current.error.code}`) : `${i.current.runtime} (${i.current.source})`,
  }));
}

async function report(json: boolean): Promise<void> {
  const r = await api.get<MigrationReportView>(`${ROUTE}/migration`);
  if (json) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(r.d75 ? `Runtime migration (D75) recorded ${r.d75}.` : color.yellow('Runtime migration (D75) not recorded yet: this is a dry run.'));
  console.log(color.dim(`AURA_USE_PROOT=${r.env.useProotEnv ?? '(unset)'}, PRoot rootfs ${r.env.rootfsPresent ? 'present' : 'missing'}; read-only, nothing is written.`));
  if (r.installations.length) console.log(`\n${table(reportRows(r))}`);
  console.log('\nrecorded reports:');
  if (!r.reports.length) console.log(color.dim('  (none)'));
  for (const f of r.reports) {
    console.log(`  ${f.file}  ${f.error ? color.yellow(`unreadable: ${f.error}`) : `${f.installations} installation(s): ${f.counts['unchanged'] ?? 0} unchanged, ${f.counts['override'] ?? 0} kept, ${f.counts['incompatible'] ?? 0} decision needed`}`);
  }
  // D100 §12: the feasibility of the runtimes in use (served once the shell has the feature view).
  const used = new Set(r.installations.map((i) => i.current.runtime).filter(Boolean));
  for (const rt of (await state()).runtimes.filter((x) => used.has(x.id) && x.features?.length)) {
    const limited = rt.features!.filter((f) => f.support !== 'supported');
    console.log(`\n${rt.id} features: ${limited.length ? limited.map((f) => `${f.id} ${featureText(f)}`).join('; ') : 'all supported'}`);
  }
  const open = r.installations.filter((i) => i.pending).length;
  if (open) console.log(color.yellow(`\n${open} decision(s) open: aura runtime migrate`));
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
      '  aura runtime override set io.example.notes container',
      '  aura runtime migrate --report',
      '  aura runtime migrate --adopt-default io.example.old',
    ].join('\n'));

  rt.command('ls').description('List the runtimes: enabled, default, health, apps and instances.')
    .option('-o, --output <fmt>', 'table | json', 'table')
    .action(async (o: { output: string }) => ls(o.output === 'json'));

  rt.command('show <id>').description('One runtime: version, ARI, health checks, capabilities, settings (with their schema), the apps on it and instances to restart.')
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
  ov.command('set <app> <runtime> [assignments...]')
    .description('Run one installation on <runtime> (ARI-3): wins over its manifest and the default. Capability-checked now and at every start; settings as <key>=<value>.')
    .action(async (ref: string, runtime: string, assignments: string[] = []) => {
      let settings: Record<string, string> | undefined;
      try { settings = assignments.length ? parseAssignments(assignments) : undefined; } catch (err) { fail((err as Error).message); }
      const s = await state();
      const inst = s.installations.find((i) => i.appId === ref || i.installationId === ref);
      if (!inst) fail(`unknown app: ${ref}`);
      if (!inst.installationId) fail(`${inst.appId} has no recorded installation yet; try again shortly`);
      const before = s.overrides.find((o) => o.installationId === inst.installationId);
      const r = await change('override set', () => api.put<{ changed: boolean; override: OverrideView }>(
        `${ROUTE}/overrides/${encodeURIComponent(inst.installationId!)}`,
        { runtime, ...(settings ? { settings } : {}), expected: before?.runtime ?? null },
      ));
      ok(r.changed ? `${inst.appId} runs on ${runtime} from its next start (owner override; installation, data and permissions unchanged)` : `${inst.appId} already has this override`);
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
    .option('--report', 'The migration report, read-only: what each installation ran on before the runtime release, what is recorded and what a start does now')
    .option('-o, --output <fmt>', 'With --report: table | json', 'table')
    .argument('[runtime]', 'With --keep: the runtime (e.g. proot)')
    .action(async (runtime: string | undefined, o: { adoptDefault?: string; keep?: string; report?: boolean; output: string }) => {
      if (o.report) {
        if (o.adoptDefault || o.keep) fail('--report changes nothing; use it alone');
        await report(o.output === 'json');
        return;
      }
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
