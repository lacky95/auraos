import type { Command } from 'commander';
import { registerAdminHomes } from './admin-homes.js';
import { registerAdminUsers } from './admin-users.js';
import { registerAdminApps } from './admin-apps.js';
import { api } from '../lib/client.js';
import { shellFetch } from '../lib/identity.js';
import { buildSystemDecisionPayload, describeDecision, releaseBody } from '../lib/system-decision.js';
import { color, fail, info, ok, table, warn } from '../lib/format.js';

/**
 * `aura admin …` — the owner's management commands: grants, the audit trail,
 * the access report, releasing system modals (D50).
 *
 * There is no admin login: the shared admin credential is gone. In the
 * System Terminal each call asks the owner, who approves it in the desktop
 * (one click; the password for privileged grants); the CLI waits and retries
 * (lib/client.ts). On the host (`docker exec -it aura-shell aura admin …`)
 * the operator acts directly. Every change is audited with the owner or the
 * operator who decided.
 */

const FEATURES: Record<string, string> = {
  locked: 'notifications.locked',
  popup: 'notifications.popup',
  read: 'notifications.read',
  systemModal: 'notifications.systemModal',
  systemmodal: 'notifications.systemModal',
  'notifications.systemModal': 'notifications.systemModal',
  'notifications.locked': 'notifications.locked',
  'notifications.popup': 'notifications.popup',
  'notifications.read': 'notifications.read',
};

/** Deprecated names (phase 6 rename desktopModal → systemModal): still accepted, with a warning. */
const DEPRECATED_FEATURES: Record<string, string> = {
  desktopModal: 'notifications.systemModal',
  desktopmodal: 'notifications.systemModal',
  'notifications.desktopModal': 'notifications.systemModal',
};

export function notifPermission(name: string): string {
  const old = DEPRECATED_FEATURES[name];
  if (old) {
    process.stderr.write(`warning: '${name}' is deprecated — use 'systemModal' (notifications.systemModal)\n`);
    return old;
  }
  // The owner's Terminal grants (D25) go by their full name.
  if (name === 'terminal.embed' || name === 'terminal.sessions.list' || name === 'terminal.screen.read') return name;
  // Writing an OS-wide KV topic (system.kv.os.<topic>.write) also goes by its full name.
  if (/^system\.kv\.os\.[A-Za-z0-9_-]{1,128}\.write$/.test(name)) return name;
  // A system Context key (Phase 5 stream C): context.read:<KEY>, for an app that declares it in context[].
  if (/^context\.read:[A-Z_][A-Z0-9_]{0,127}$/.test(name)) return name;
  // B12b: a root installation's inheritHome sidecar template gets the app's home: home.inherit.sidecar:<template>.
  if (/^home\.inherit\.sidecar:[a-z][a-z0-9-]{0,47}$/.test(name)) return name;
  const p = FEATURES[name];
  if (!p) fail(`unknown notification permission '${name}' — use locked | popup | read | systemModal, or terminal.embed | terminal.sessions.list | terminal.screen.read | system.kv.os.<topic>.write | context.read:<KEY> | home.inherit.sidecar:<template>`);
  return p!;
}

/** `read` grants (phase 5): which senders, and whether secret items count. */
export interface ReadGrantOpts {
  scope?: string;
  includeSecret?: boolean;
}

interface GrantsDto {
  privileged: string[];
  apps: Array<{ appId: string; name?: string; scope: string | null; sends: boolean; requested: string[]; granted: string[]; effective: string[]; read?: { label: string } }>;
  grants: Array<{ subject: { kind: string; id: string }; permission: string; appScope?: string; grantedAt: number }>;
}

export async function fetchNotifPerms(): Promise<GrantsDto> {
  return api.get<GrantsDto>('/api/admin/grants');
}

export async function grantNotif(verb: 'grant' | 'revoke', appId: string, features: string[], readOpts: ReadGrantOpts = {}): Promise<void> {
  if (features.length === 0) fail(`aura ${verb} notif-perms <app> <locked|popup|read...>`);
  for (const f of features) {
    const permission = notifPermission(f);
    if (verb === 'grant') {
      const isRead = permission === 'notifications.read';
      if (isRead && !readOpts.scope) {
        fail('read needs --scope: app:<appId>, sender:<senderKey> (comma-separated) or all — e.g. aura grant nperm com.example.x read --scope app:com.example.y');
      }
      if (!isRead && (readOpts.scope || readOpts.includeSecret)) warn(`--scope / --include-secret only apply to read (ignored for ${f})`);
      const r = await api.post<{ changed: boolean; warnings?: string[]; record: { appScope?: string; read?: { includeSecret: boolean } } }>(
        '/api/admin/grants', {
          subjectKind: 'app', subjectId: appId, permission,
          ...(isRead ? { readScope: readOpts.scope, includeSecret: readOpts.includeSecret === true } : {}),
        });
      const what = isRead ? ` (read ${readOpts.scope}${readOpts.includeSecret ? ', secret included' : ''})` : '';
      if (r.changed) ok(`granted ${color.bold(permission)} to ${color.bold(appId)}${what}${r.record.appScope ? color.dim(` (scope ${r.record.appScope})`) : ''}`);
      else info(`${appId} already has ${permission}`);
      for (const w of r.warnings ?? []) warn(w);
    } else {
      const r = await api.del<{ changed: boolean }>(
        `/api/admin/grants?subjectKind=app&subjectId=${encodeURIComponent(appId)}&permission=${encodeURIComponent(permission)}`);
      if (r.changed) ok(`revoked ${color.bold(permission)} from ${color.bold(appId)}`);
      else info(`${appId} had no grant of ${permission}`);
    }
  }
}

export function fmtTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export function registerAdmin(program: Command): void {
  const admin = program
    .command('admin')
    .description("The owner's management: grants, the audit trail, the access report. From the System Terminal each call waits for the owner's approval in the desktop; on the host it runs directly.");

  admin
    .command('grants')
    .description('Privileged permissions per app: requested (manifest) vs granted (owner) vs effective.')
    .action(async () => {
      const d = await fetchNotifPerms();
      if (d.apps.length === 0) { info('no app sends or requests notification permissions'); return; }
      console.log(table(d.apps.map((a) => ({
        APP: a.appId,
        SCOPE: a.scope ?? '-',
        SENDS: a.sends ? 'yes' : color.dim('no'),
        REQUESTED: a.requested.map((p) => p.replace('notifications.', '')).join(',') || color.dim('-'),
        GRANTED: a.granted.map((p) => p.replace('notifications.', '')).join(',') || color.dim('-'),
        EFFECTIVE: a.effective.map((p) => p.replace('notifications.', '')).join(',') || color.dim('-'),
        READS: a.read?.label ?? color.dim('-'),
      }))));
    });

  admin
    .command('grant <app> <features...>')
    .description("Grant privileged notification features (locked | popup | read | systemModal), or a system Context key (context.read:<KEY>), to an app. The app must also request them in its manifest (a Context key: in context[]). read = other senders' notifications, scoped with --scope.")
    .option('--scope <scope>', 'read: app:<appId>, sender:<senderKey> (comma-separated) or all')
    .option('--include-secret', 'read: secret notifications too (default: not)')
    .action((app: string, features: string[], opts: { scope?: string; includeSecret?: boolean }) => grantNotif('grant', app, features, opts));

  admin
    .command('revoke <app> <features...>')
    .description('Revoke privileged notification features (locked | popup | read | systemModal). Takes effect at once; revoking systemModal releases that app\'s blocking modals.')
    .action((app: string, features: string[]) => grantNotif('revoke', app, features));

  registerAdminDev(admin);
  registerAdminNotif(admin);

  admin
    .command('access-report')
    .description('What the access policy decided, per route and caller. wouldEnforce marks what AURA_ACCESS_ENFORCE=enforce would refuse.')
    .option('--days <n>', 'days to show, newest first (1-14)', '1')
    .option('-o, --output <format>', 'json')
    .action(async (opts: { days: string; output?: string }) => {
      const days = Number(opts.days);
      if (!Number.isInteger(days) || days < 1 || days > 14) fail('--days must be a whole number from 1 to 14');
      let report: unknown;
      try {
        report = await api.get<unknown>(`/api/admin/access-report?days=${days}`);
      } catch (err) {
        const e = err as Error & { status?: number };
        if (e.status === 404) fail('this shell has no access report yet.');
        fail(e.message);
        return;
      }
      if (opts.output === 'json') { console.log(JSON.stringify(report, null, 2)); return; }
      printAccessReport(report);
    });

  admin
    .command('contract-report')
    .description('The app contract (D48) per app: the contract it was built for, what it declares, undeclared use (source scan and access-report signals), raw Context reads. --datadir adds the writes outside each app\'s data directory.')
    .option('--datadir', 'also list writes outside dataDir (install folder, container layer, home mount)')
    .option('-o, --output <format>', 'json')
    .action(async (opts: { datadir?: boolean; output?: string }) => {
      let report: unknown;
      try {
        report = await api.get<unknown>(`/api/admin/contract-report${opts.datadir ? '?datadir=1' : ''}`);
      } catch (err) {
        const e = err as Error & { status?: number };
        if (e.status === 404) fail('this shell has no contract report yet.');
        fail(e.message);
        return;
      }
      if (opts.output === 'json') { console.log(JSON.stringify(report, null, 2)); return; }
      printContractReport(report);
    });

  admin
    .command('audit')
    .description('The audit trail, newest first: who (the owner or the host operator) changed what.')
    .option('-n, --limit <n>', 'entries', '30')
    .action(async (opts: { limit: string }) => {
      const { entries } = await api.get<{ entries: Array<{ at: number; actor: string; action: string; target?: string; outcome: string; detail?: unknown }> }>(
        `/api/admin/audit?limit=${encodeURIComponent(opts.limit)}`);
      if (entries.length === 0) { info('no audit entries'); return; }
      console.log(table(entries.map((e) => ({
        TIME: fmtTime(e.at),
        ACTOR: e.actor,
        ACTION: e.action,
        TARGET: e.target ?? '-',
        OUTCOME: e.outcome === 'ok' ? e.outcome : color.yellow(e.outcome),
        DETAIL: e.detail ? JSON.stringify(e.detail) : '',
      }))));
    });

  registerAdminSecurity(admin);
  registerAdminInfra(admin);
  registerAdminHomes(admin);
  registerAdminUsers(admin);
  registerAdminApps(admin);
}

interface SecurityOptionDto {
  id: string; title: string; description: string; type: string; values?: string[];
  default: unknown; value: unknown; source: string; effectiveSource: string; env?: string;
  writable: boolean; restartRequired: boolean; phase: string; invalidEnv?: boolean;
}

const showValue = (v: unknown): string =>
  v === true ? 'on' : v === false ? 'off' : Array.isArray(v) ? (v.join(',') || '-') : v === null || v === undefined ? '-' : String(v);

/**
 * `aura admin security [list] | set <id> <value>`: the security options
 * registry (D64). A change is the owner's with the password (`fresh`): from
 * the System Terminal it waits for the owner's approval; on the host the
 * operator acts directly. Options set on the host (env) are shown, not set.
 */
function registerAdminSecurity(admin: Command): void {
  const security = admin
    .command('security')
    .description('Security options (D64): every security switch, its value and where it comes from. `set` changes a writable one.');

  security
    .command('list', { isDefault: true })
    .alias('options')
    .description('Every security option: value, source (default, policy, env), and what it does.')
    .option('-o, --output <fmt>', 'json for the full records')
    .action(async (opts: { output?: string }) => {
      const { options } = await api.get<{ options: SecurityOptionDto[] }>('/api/admin/security-options');
      if (opts.output === 'json') { console.log(JSON.stringify(options, null, 2)); return; }
      console.log(table(options.map((o) => ({
        ID: o.id,
        VALUE: o.invalidEnv ? color.yellow(`${showValue(o.value)} (invalid env)`) : showValue(o.value),
        SOURCE: o.effectiveSource,
        SET: o.writable ? 'aura admin security set' : o.source === 'file' ? color.dim('own setting') : o.env ? `${o.env} on the host` : o.source === 'reserved' ? color.dim('not yet available') : color.dim('own setting'),
        TITLE: o.title,
      }))));
    });

  security
    .command('set <id> <value>')
    .description('Set a writable security option, e.g. `set fresh-auth-require-https on`. Needs the owner\'s password in the desktop, or run it on the host.')
    .action(async (id: string, value: string) => {
      const v = value === 'on' || value === 'true' ? true : value === 'off' || value === 'false' ? false : value;
      const r = await api.put<{ changed: boolean; option: SecurityOptionDto }>('/api/admin/security-options', { id, value: v });
      if (r.changed) ok(`${color.bold(r.option.id)} = ${showValue(r.option.value)}`);
      else info(`${r.option.id} is already ${showValue(r.option.value)}`);
    });
}

interface InfraDoctorDto {
  configured: boolean; ok: boolean; digest: string | null;
  checks: Array<{ id: string; status: 'ok' | 'warn' | 'fail' | 'skip'; message: string }>;
}

/**
 * `aura admin infra doctor` (D94 IC-7, O9): the infrastructure configuration
 * checked against the running system. Categories and plain words only, never
 * a value; exits 1 when a check fails. On the host:
 * `docker exec aura-shell aura admin infra doctor`.
 */
function registerAdminInfra(admin: Command): void {
  const infra = admin
    .command('infra')
    .description('Infrastructure configuration (D94): proxy, CAs, mirrors and registries for corporate networks.');
  infra
    .command('doctor')
    .description('Check the infrastructure config, its render, certificates, the infra-* security options and the configured endpoints.')
    .option('--offline', 'skip the network probes (proxy, registries)')
    .option('-o, --output <fmt>', 'json for the full report')
    .action(async (opts: { offline?: boolean; output?: string }) => {
      const r = await api.post<InfraDoctorDto>(`/api/admin/infra/doctor${opts.offline ? '?offline=1' : ''}`, {});
      if (opts.output === 'json') { console.log(JSON.stringify(r, null, 2)); if (!r.ok) process.exitCode = 1; return; }
      const mark = { ok: color.green('ok'), warn: color.yellow('warn'), fail: color.red('FAIL'), skip: color.dim('skip') } as const;
      console.log(table(r.checks.map((c) => ({ CHECK: c.id, STATUS: mark[c.status], DETAIL: c.message }))));
      if (!r.configured) info('no infrastructure configuration: AuraOS uses the public defaults');
      else if (r.ok) ok(`infrastructure ${r.digest ? r.digest.slice(0, 19) : ''} ok`);
      else { warn('infrastructure: some checks failed (see above)'); process.exitCode = 1; }
    });
}

const REPORT_COLUMNS = ['surface', 'subject', 'method', 'variant', 'principal', 'appId', 'decision', 'reason', 'status', 'via', 'wouldEnforce', 'count'];

interface AccessReportBody {
  days: Array<{ day: string; rows: Array<Record<string, unknown>>; counters: Record<string, number> }>;
  samples: Array<Record<string, string>>;
  pending: { keys: number; events: number; meta: Record<string, number> } | null;
}

function isAccessReport(v: unknown): v is AccessReportBody {
  const r = v as Partial<AccessReportBody> | null;
  return !!r && Array.isArray(r.days) && Array.isArray(r.samples)
    && r.days.every((d) => !!d && typeof d.day === 'string' && Array.isArray(d.rows) && !!d.counters && typeof d.counters === 'object');
}

/** The shape of GET /api/admin/access-report: days of rows, samples, pending. */
export function printAccessReport(report: unknown): void {
  if (!isAccessReport(report)) { console.log(JSON.stringify(report, null, 2)); return; }
  const cell = (v: unknown): string => (v === null || v === undefined ? '-' : String(v));
  const rowsOf = (rows: Array<Record<string, unknown>>, columns: string[]) =>
    rows.map((row) => Object.fromEntries(columns.map((c) => [c, cell(row[c])])));
  for (const d of report.days) {
    console.log(`\n${color.bold(d.day)}`);
    if (d.rows.length === 0) info('no events');
    else console.log(table(rowsOf(d.rows, REPORT_COLUMNS), REPORT_COLUMNS));
    const counters = Object.entries(d.counters);
    if (counters.length) console.log(`counters: ${counters.map(([k, n]) => `${k}=${n}`).join(' ')}`);
  }
  console.log(`\n${color.bold('would-deny samples')}`);
  if (report.samples.length === 0) info('none');
  else {
    const columns = [...new Set(report.samples.flatMap((row) => Object.keys(row)))];
    console.log(table(rowsOf(report.samples, columns), columns));
  }
  if (report.pending) console.log(`\npending flush: ${report.pending.events} event(s) in ${report.pending.keys} key(s)`);
}

interface ContractReportBody {
  contract: number;
  summary: Record<string, number>;
  /** Why the `incompatible` apps are refused (shells before owner decision 11 send none). */
  incompatibleBy?: { contract: number; setup: number };
  apps: Array<{
    appId: string; scope: string;
    contract: { version: number | null; status: string };
    findings: Array<{ code: string; message: string }>;
    source: Array<{ file: string; line: number; code: string; message: string }>;
    signals: Record<string, number>;
    readsRawContext: boolean;
    /** The start gate's refusal code, when AuraOS never starts the app. */
    blocked?: string;
    dataDir?: { outside: boolean; home: string; installFolder: { writes: string[] }; containerLayer: Array<{ instanceId: string; writes?: string[]; error?: string }> };
  }>;
}

/** GET /api/admin/contract-report as a table plus the details per app. */
export function printContractReport(report: unknown): void {
  const r = report as Partial<ContractReportBody> | null;
  if (!r || !Array.isArray(r.apps) || typeof r.contract !== 'number') { console.log(JSON.stringify(report, null, 2)); return; }
  const withDataDir = r.apps.some((a) => a.dataDir);
  console.log(table(r.apps.map((a) => ({
    APP: a.appId,
    SCOPE: a.scope,
    CONTRACT: a.blocked === 'setup-unsupported' ? color.red(`${a.contract.version ?? 'none'} incompatible (setup)`)
      : a.contract.version === null ? color.yellow('none') : a.contract.status === 'current' ? String(a.contract.version) : color.red(`${a.contract.version} incompatible`),
    FINDINGS: String(a.findings.length + a.source.length),
    'RAW-CONTEXT': a.readsRawContext ? color.yellow('yes') : '-',
    SIGNALS: Object.entries(a.signals).map(([k, n]) => `${k}=${n}`).join(' ') || '-',
    ...(withDataDir ? { 'OUTSIDE-DATADIR': a.dataDir?.outside ? color.yellow('yes') : '-' } : {}),
  }))));
  for (const a of r.apps) {
    const lines = [
      ...a.findings.map((f) => `manifest: ${f.message}`),
      ...a.source.map((f) => `${f.file}:${f.line}: ${f.message}`),
      ...(a.dataDir?.installFolder.writes.length ? [`writes in its install folder: ${a.dataDir.installFolder.writes.join(', ')}`] : []),
      ...(a.dataDir?.containerLayer ?? []).flatMap((c) => (c.writes?.length ? [`${c.instanceId} wrote outside its mounts: ${c.writes.join(', ')}`] : c.error ? [`${c.instanceId}: ${c.error}`] : [])),
    ];
    if (lines.length === 0) continue;
    console.log(`\n${color.bold(a.appId)}`);
    for (const l of lines) console.log(`  ${l}`);
  }
  const by = r.incompatibleBy && r.incompatibleBy.contract + r.incompatibleBy.setup > 0
    ? ` (incompatible: contract=${r.incompatibleBy.contract} setup=${r.incompatibleBy.setup})` : '';
  console.log(`\ncontract ${r.contract}: ${Object.entries(r.summary ?? {}).map(([k, n]) => `${k}=${n}`).join(' ')}${by}`);
}

// ─── aura admin notif … ─────────────────────────────────────────────────────

export function registerAdminNotif(admin: Command): void {
  const notif = admin.command('notif').description("The owner's actions on notifications.");
  notif
    .command('release [id]')
    .description("Stop app system modals from blocking the shell (escape hatch): one by id, or every active one of --app. They stay as normal dialogues; the sender sees reason 'admin-released'. AuraOS decisions cannot be released.")
    .option('--app <appId>', 'every active system modal of this app')
    .action(async (id: string | undefined, opts: { app?: string }) => {
      let body: { id: string } | { appId: string };
      try { body = releaseBody(id, opts); } catch (err) { fail((err as Error).message); return; }
      const r = await api.post<{ released: string[] }>('/api/admin/notifications/release', body);
      if (r.released.length) ok(`released ${r.released.length} system modal(s): ${r.released.join(', ')}`);
      else info('nothing was blocking');
    });
}

// ─── aura admin dev … (DEV-only test hooks) ─────────────────────────────────

export function registerAdminDev(admin: Command): void {
  const dev = admin
    .command('dev')
    .description("DEV-only test hooks (dev shell only, the owner's, audited).");
  dev
    .command('system-decision')
    .description('Show an AuraOS system decision: a desktop-wide modal (scope system) that BLOCKS THE WHOLE DESKTOP until answered. Dev shell only; created as AuraOS, audited as dev.systemDecision.')
    .option('--title <t>', 'title')
    .option('--text <x>', 'text')
    .option('--priority <p>', 'low | medium | high (default) | urgent')
    .option('--inputs [labels]', 'add inputs: comma-separated labels (default: one "Reason")')
    .option('--options [labels]', 'add a choice: comma-separated labels (default: Allow, Deny, Ask me later); > 4 → a radio list')
    .option('--cancel-label <l>', 'text of the Cancel button')
    .option('--submit-label <l>', 'text of the Submit button')
    .option('--json <payload>', 'a full notification input as JSON (the flags above override it); type / scope are forced')
    .option('--wait [seconds]', 'wait for the answer and print it (default 300 s)')
    .option('-o, --output <fmt>', 'json: print the raw responses')
    .action(async (opts: {
      title?: string; text?: string; priority?: string; inputs?: boolean | string; options?: boolean | string;
      cancelLabel?: string; submitLabel?: string; json?: string; wait?: boolean | string; output?: string;
    }) => {
      let payload: Record<string, unknown>;
      try { payload = buildSystemDecisionPayload(opts); } catch (err) { fail((err as Error).message); return; }
      let r: { notification: { id: string; title: string }; warnings?: Array<{ message: string }> };
      try {
        r = await api.post('/api/admin/dev/system-decision', { payload });
      } catch (err) {
        const e = err as Error & { status?: number };
        if (e.status === 404 || /404/.test(e.message)) {
          fail('refused: the system-decision hook exists only on the DEV shell (astro dev). Production shells have no way to create a system decision from outside AuraOS.');
        }
        fail(e.message);
        return;
      }
      if (opts.output === 'json') console.log(JSON.stringify(r, null, 2));
      else {
        ok(`system decision ${color.bold(r.notification.id)} "${r.notification.title}" — it blocks the desktop until answered`);
        for (const w of r.warnings ?? []) warn(w.message);
      }
      process.stdout.write(`${r.notification.id}\n`);
      if (opts.wait === undefined || opts.wait === false) return;
      const total = opts.wait === true ? 300 : Number(opts.wait);
      if (!Number.isFinite(total) || total <= 0) fail('--wait takes a number of seconds');
      const deadline = Date.now() + total * 1000;
      info(`waiting up to ${total} s for the answer…`);
      for (;;) {
        const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        const t = Math.min(25, left);
        // The host operator reads every notification; in a sandbox, the app's own view.
        const res = await shellFetch(`/api/notifications/${encodeURIComponent(r.notification.id)}?waitFor=resolved&timeout=${t}`, { intent: 'self' })
          .catch((err: Error) => fail(`cannot reach the shell: ${err.message}`));
        const n = await (res as Response).json() as { state: string; outcome?: string; answer?: unknown; removedReason?: string; error?: string };
        if (!(res as Response).ok) fail(`waiting failed: ${(res as Response).status} ${n.error ?? ''}`);
        if (n.state !== 'active') {
          if (opts.output === 'json') console.log(JSON.stringify(n, null, 2));
          ok(`answer: ${describeDecision(n)}`);
          return;
        }
        if (Date.now() >= deadline) { warn(`still pending after ${total} s (${r.notification.id})`); return; }
      }
    });
}

// ─── aura apikey ────────────────────────────────────────────────────────────

const SCOPE_ALIASES: Record<string, string> = {
  send: 'system.notifications', notifications: 'system.notifications', 'system.notifications': 'system.notifications',
  locked: 'notifications.locked', 'notifications.locked': 'notifications.locked',
  popup: 'notifications.popup', 'notifications.popup': 'notifications.popup',
};

export function registerApiKey(program: Command): void {
  const key = program
    .command('apikey')
    .description("API keys for external REST callers (the owner's; creating one needs the password). A key authenticates as `Authorization: Bearer aura_k1_…`.");

  key
    .command('create <name>')
    .description('Create a key. The secret is shown ONCE. Scopes: send (default), locked, popup.')
    .option('-s, --scope <scope...>', 'send | locked | popup (repeatable)', ['send'])
    .action(async (name: string, opts: { scope: string[] }) => {
      const scopes = [...new Set(opts.scope.map((s) => {
        const v = SCOPE_ALIASES[s];
        if (!v) fail(`unknown scope '${s}' — use send | locked | popup`);
        return v!;
      }))];
      const r = await api.post<{ key: string; apiKey: { id: string; name: string; scopes: string[] } }>('/api/admin/api-keys', { name, scopes });
      ok(`created API key ${color.bold(r.apiKey.id)} (${r.apiKey.name}) — scopes ${r.apiKey.scopes.join(', ')}`);
      warn('The key is shown only now. Store it somewhere safe:');
      process.stdout.write(`${r.key}\n`);
    });

  key
    .command('ls')
    .alias('list')
    .description('List keys (never secrets).')
    .action(async () => {
      const { keys } = await api.get<{ keys: Array<{ id: string; name: string; scopes: string[]; createdAt: number; lastUsedAt?: number; revokedAt?: number }> }>('/api/admin/api-keys');
      if (keys.length === 0) { info('no API keys'); return; }
      console.log(table(keys.map((k) => ({
        ID: k.id,
        NAME: k.name,
        SCOPES: k.scopes.join(','),
        CREATED: fmtTime(k.createdAt),
        'LAST-USED': k.lastUsedAt ? fmtTime(k.lastUsedAt) : color.dim('never'),
        STATE: k.revokedAt ? color.dim('revoked') : color.green('active'),
      }))));
    });

  key
    .command('revoke <id>')
    .description('Revoke a key: it gets 401 at once.')
    .action(async (id: string) => {
      const r = await api.del<{ apiKey: { id: string; name: string } }>(`/api/admin/api-keys?id=${encodeURIComponent(id)}`);
      ok(`revoked API key ${color.bold(r.apiKey.id)} (${r.apiKey.name})`);
    });
}
