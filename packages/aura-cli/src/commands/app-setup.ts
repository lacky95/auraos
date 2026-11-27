import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { FIELD_NAME_RE, isCredentialHandle } from '@aura/core';
import type {
  HomePrivateGrantView, LastAppliedView, ProfileOption, SetupChangePlan, SetupErrorBody, SetupOutcome, SetupProposal, SetupStateView, SetupValuesView,
} from '@aura/core';
import { EXIT_ON_HOLD, exitOnHold, outcomeText, printApprovalResult, waitForApproval, waitsOnHold } from '../lib/approval.js';
import { color, table } from '../lib/format.js';
import { shellFetch } from '../lib/identity.js';
import { shellUrl } from '../lib/shell-url.js';

/**
 * `aura app setup|config|profile` (D108): the CLI client of the setup engine
 * (`/api/apps/<id>/setup/**`, core setup/contracts.ts). Non-interactive with
 * `--profile` and `--values`; secrets only by vault handle
 * (`--secret <field>=@vault:<handle>`), never a value on the command line.
 * Approvals are never skipped (no `--yes`): an agent without a TTY gets exit
 * 75 (on hold, D102) with the request id and how to resume, a TTY (or
 * `AURA_WAIT_ON_HOLD=1`) waits for the decision and then resumes, the host
 * operator decides with `aura approve`. Exit codes: 0 ready, 3 needs setup or
 * blocked (D105 `needs-setup`, an unsupported or unauthorized requirement), 5
 * invalid input (`invalid-request`), 75 on hold, 1 anything else.
 *
 * P8: `profile use` shows the change plan first (what privileges it adds and
 * removes, the data that stays behind); `config restore-last` restores the
 * last applied configuration (decision 13; revalidated, app data is not
 * rolled back); `config revoke-private-home` revokes the caller's own
 * Private Home grant of an app (the app becomes blocked).
 */

/** Exit when the app needs setup or is blocked (D105 `needs-setup`). */
export const EXIT_NEEDS_SETUP = 3;
/** Exit on invalid values, an unknown profile or field (D105 `invalid-request`). */
export const EXIT_INVALID_INPUT = 5;
/** How long a run that is initializing is followed before the CLI hands back (`--resume` continues). */
const INIT_FOLLOW_MS = 15 * 60_000;
const POLL_MS = 2_000;

const collect = (v: string, prev: string[] = []): string[] => [...prev, v];

// ── output and exits ────────────────────────────────────────────────────────

interface Out { json: boolean }

function outputOf(o: string | undefined): Out {
  if (o === undefined) return { json: false };
  if (o === 'json') return { json: true };
  return exitWith(EXIT_INVALID_INPUT, `unknown output format '${o}' (use -o json)`);
}

function exitWith(code: number, message: string): never {
  process.stderr.write(`${color.red('✗')} ${message}\n`);
  process.exit(code);
}

const printJson = (v: unknown): void => { process.stdout.write(`${JSON.stringify(v, null, 2)}\n`); };

/** The exit code of a refusal: 5 for invalid input, 3 for the app's state or what this system can't do. */
export const exitOfError = (b: Pick<SetupErrorBody, 'category'> | undefined): number =>
  (b?.category === 'invalid-request' ? EXIT_INVALID_INPUT : EXIT_NEEDS_SETUP);

/** The human lines of a D105 refusal: never a value, only names, reasons and what to do. */
export function errorLines(b: SetupErrorBody): string[] {
  const out = [`${b.message}${b.error ? color.dim(` (${b.error})`) : ''}`];
  for (const [f, why] of Object.entries(b.fieldErrors ?? {})) out.push(`  ${f}: ${why}`);
  if (b.missing?.length) out.push(`  missing: ${b.missing.join(', ')}`);
  if (b.manifestField) out.push(`  manifest: ${b.manifestField}`);
  if (b.policy) out.push(`  policy: ${b.policy}`);
  if (b.suggest?.length) out.push(`  available profiles: ${b.suggest.join(', ')} (choose one with --profile)`);
  if (b.hint) out.push(`  ${b.hint}`);
  return out;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

interface Answer { status: number; body: unknown }

async function call(method: string, path: string, body?: unknown): Promise<Answer> {
  let res: Response;
  try {
    res = await shellFetch(path, {
      method, intent: 'self',
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    return exitWith(1, `Cannot reach AuraOS shell at ${shellUrl()}: ${String(err)}`);
  }
  const text = await res.text();
  try {
    return { status: res.status, body: text ? JSON.parse(text) as unknown : null };
  } catch {
    return { status: res.status, body: { error: `HTTP ${res.status}`, message: text.slice(0, 200) } };
  }
}

const setupPath = (app: string, sub = ''): string => `/api/apps/${encodeURIComponent(app)}/setup${sub}`;

const isErrorBody = (v: unknown): v is SetupErrorBody =>
  !!v && typeof v === 'object' && typeof (v as SetupErrorBody).error === 'string' && typeof (v as SetupErrorBody).category === 'string';

const OUTCOME_STATUSES: ReadonlySet<string> = new Set(['ready', 'initializing', 'on-hold', 'refused', 'unchanged']);
const isOutcome = (v: unknown): v is SetupOutcome =>
  !!v && typeof v === 'object' && OUTCOME_STATUSES.has(String((v as SetupOutcome).status)) && !!(v as SetupOutcome).state;

/** A non-2xx answer: print it and exit with its code. */
function refuse(a: Answer, out: Out): never {
  if (out.json) printJson(a.body);
  const b = a.body as { error?: string; category?: string; message?: string; hint?: string } | null;
  if (isErrorBody(b) && (a.status === 409 || a.status === 422)) {
    if (!out.json) for (const l of errorLines(b as SetupErrorBody)) process.stderr.write(`${l}\n`);
    process.exit(exitOfError(b as SetupErrorBody));
  }
  const why = b?.message ?? b?.error ?? `HTTP ${a.status}`;
  if (a.status === 400 || a.status === 415 || a.status === 422) exitWith(EXIT_INVALID_INPUT, why);
  if (a.status === 404) exitWith(1, b?.error === 'app-not-found' ? 'no such app (use its id, e.g. com.example.app)' : why);
  return exitWith(1, `${why}${b?.hint ? `\n  ${b.hint}` : ''}`);
}

/** GET a view, or exit with the refusal. */
async function getView<T>(path: string, out: Out): Promise<T> {
  const a = await call('GET', path);
  if (a.status !== 200) refuse(a, out);
  return a.body as T;
}

// ── inputs ──────────────────────────────────────────────────────────────────

/**
 * `--secret field=@vault:<handle>`: a vault handle only. Anything else is
 * refused (exit 5) without echoing it: a secret never travels as a value.
 */
export function parseSecrets(args: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args) {
    const eq = a.indexOf('=');
    const field = eq > 0 ? a.slice(0, eq) : '';
    if (!field || !FIELD_NAME_RE.test(field)) exitWith(EXIT_INVALID_INPUT, '--secret takes <field>=@vault:<handle>');
    const ref = a.slice(eq + 1);
    if (!ref.startsWith('@vault:') || !isCredentialHandle(ref.slice('@vault:'.length))) {
      exitWith(EXIT_INVALID_INPUT, `--secret ${field}: only a vault handle (@vault:cred_…) is accepted, never a secret value on the command line. `
        + 'Store the secret first (aura secret), then pass its handle.');
    }
    out[field] = ref.slice('@vault:'.length);
  }
  return out;
}

/** `--values <file>`: a JSON object of field → value. */
export function readValuesFile(file: string): Record<string, unknown> {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf-8')); } catch (err) { return exitWith(EXIT_INVALID_INPUT, `--values ${file}: ${(err as Error).message}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) exitWith(EXIT_INVALID_INPUT, `--values ${file}: must be a JSON object of field → value`);
  return raw as Record<string, unknown>;
}

/** `field=value` on `config set`: true/false and numbers as such, everything else a string; `@vault:` a secret handle. */
export function parseAssignments(args: readonly string[]): { values: Record<string, unknown>; secrets: Record<string, string> } {
  const values: Record<string, unknown> = {};
  const secretArgs: string[] = [];
  for (const a of args) {
    const eq = a.indexOf('=');
    const field = eq > 0 ? a.slice(0, eq) : '';
    if (!field || !FIELD_NAME_RE.test(field)) exitWith(EXIT_INVALID_INPUT, `'${field || a.split('=')[0]}': assignments take <field>=<value>`);
    const v = a.slice(eq + 1);
    if (v.startsWith('@vault:')) { secretArgs.push(a); continue; }
    values[field] = v === 'true' ? true : v === 'false' ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return { values, secrets: parseSecrets(secretArgs) };
}

/**
 * Refuse, before anything is sent, a plain value for a field the app declares
 * as a secret (the server refuses it too). Best effort: the field list is the
 * server's; without it the server's check stands alone.
 */
async function refuseSecretValues(app: string, values: Record<string, unknown> | undefined): Promise<void> {
  if (!values || !Object.keys(values).length) return;
  const a = await call('GET', setupPath(app, '/values'));
  if (a.status !== 200) return;
  const secretNames = new Set(((a.body as SetupValuesView).fields ?? []).filter((f) => f.field.type === 'secret').map((f) => f.name));
  const bad = Object.keys(values).filter((k) => secretNames.has(k));
  if (bad.length) {
    exitWith(EXIT_INVALID_INPUT, `${bad.join(', ')} ${bad.length > 1 ? 'are secret fields' : 'is a secret field'}: pass a vault handle with --secret ${bad[0]}=@vault:<handle>, never a value`);
  }
}

// ── outcomes ────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Carry a change to its end: ready (0), refused (3/5), on hold (75 without a
 * TTY; a TTY waits for the owner, then resumes), initializing (followed).
 */
async function finish(app: string, first: Answer, out: Out, deps: { pollMs?: number; followMs?: number } = {}): Promise<never> {
  const resumeCmd = `aura app setup ${app} --resume`;
  let a = first;
  let waited = false;
  for (;;) {
    // A SetupOutcome at any status (a refused one comes as 409/422); anything else is a route refusal.
    if (!isOutcome(a.body)) refuse(a, out);
    const o = a.body;
    if (o.status === 'ready' || o.status === 'unchanged') {
      if (out.json) printJson(o);
      else process.stderr.write(`${color.green('✓')} ${app}: ${o.status === 'unchanged' ? 'unchanged' : 'ready'}${o.state?.profile ? color.dim(` (profile ${o.state.profile})`) : ''}\n`);
      process.exit(0);
    }
    if (o.status === 'refused') {
      if (out.json) printJson(o);
      else if (o.error) for (const l of errorLines(o.error)) process.stderr.write(`${l}\n`);
      process.exit(exitOfError(o.error));
    }
    if (o.status === 'on-hold') {
      const id = o.approvalId ?? o.state?.approvalId;
      if (!id) exitWith(1, `${app}: waiting for an approval the server did not name; run ${resumeCmd} later`);
      // An agent without a TTY: the request id and how to continue, exit 75. Never a skip.
      if (!waitsOnHold() || waited) {
        if (out.json) {
          printJson({ ...o, approvalId: id, resume: resumeCmd });
          process.exit(EXIT_ON_HOLD);
        }
        exitOnHold(id, {}, undefined, `After the owner decided, continue with: ${resumeCmd}`);
      }
      waited = true;
      process.stderr.write(`Waiting for the owner's approval ${id} (in the AuraOS desktop, or on the host: aura approve ${id}). Ctrl-C withdraws it.\n`);
      const r = await waitForApproval(id, { waitOnHold: true });
      if (r.outcome !== 'approved') {
        if (out.json) printJson({ ...o, approvalId: id, approval: r.outcome });
        else { process.stderr.write(`${color.red('✗')} ${outcomeText(r)}\n`); printApprovalResult(id, r); }
        process.exit(EXIT_NEEDS_SETUP);
      }
      a = await call('POST', setupPath(app, '/resume'), {});
      continue;
    }
    // initializing: the app's own setup runs; follow it to its end.
    if (!out.json) process.stderr.write(`${app}: initializing…\n`);
    const until = Date.now() + (deps.followMs ?? INIT_FOLLOW_MS);
    let state: SetupStateView | null = null;
    while (Date.now() < until) {
      await sleep(deps.pollMs ?? POLL_MS);
      const s = await call('GET', setupPath(app));
      if (s.status !== 200) refuse(s, out);
      state = s.body as SetupStateView;
      if (state.state !== 'initializing') break;
    }
    if (!state || state.state === 'initializing') {
      if (out.json) printJson({ ...o, resume: resumeCmd });
      exitWith(EXIT_NEEDS_SETUP, `${app} is still initializing; check again with ${resumeCmd}`);
    }
    if (state.state === 'ready') {
      if (out.json) printJson({ status: 'ready', state });
      else process.stderr.write(`${color.green('✓')} ${app}: ready\n`);
      process.exit(0);
    }
    if (state.state === 'awaiting-approval') { a = { status: 202, body: { status: 'on-hold', state, approvalId: state.approvalId } }; continue; }
    if (out.json) printJson({ status: 'refused', state, ...(state.error ? { error: state.error } : {}) });
    else for (const l of state.error ? errorLines(state.error) : [`${app}: ${state.state}`]) process.stderr.write(`${l}\n`);
    process.exit(exitOfError(state.error));
  }
}

// ── human views ─────────────────────────────────────────────────────────────

const showValue = (v: unknown): string => (Array.isArray(v) ? v.join(',') : v === undefined ? '-' : String(v));

function printValues(app: string, state: SetupStateView, v: SetupValuesView): void {
  console.log(`${color.bold(app)}  state ${state.declares ? state.state : 'ready (no setup)'}${v.profile ? `  profile ${v.profile}` : ''}`);
  if (state.error) for (const l of errorLines(state.error)) console.log(`  ${l}`);
  if (!v.fields.length) { console.log(color.dim('  no setup fields')); return; }
  const desired = v.desired;
  const effective = v.effective;
  console.log(table(v.fields.map((f) => ({
    FIELD: f.name,
    TYPE: f.field.type,
    // Secrets: the vault handle only, never a value.
    DESIRED: f.field.type === 'secret' ? (desired?.secrets[f.name] ? `@vault:${desired.secrets[f.name]}` : '-') : showValue(desired?.values[f.name]),
    EFFECTIVE: f.field.type === 'secret' ? (effective?.secrets[f.name] ? `@vault:${effective.secrets[f.name]}` : '-') : showValue(effective?.values[f.name]),
    ...(f.error ? { NOTE: f.error } : { NOTE: '' }),
  })), ['FIELD', 'TYPE', 'DESIRED', 'EFFECTIVE', 'NOTE']));
  for (const d of v.degraded) console.log(color.yellow(`  degraded: ${d.reason}`));
}

function printPlanChanges(plan: SetupChangePlan): void {
  const adds = plan.approval?.adds;
  if (adds) {
    const lines = [
      ...adds.permissions.map((p) => `permission ${p}`), ...adds.tools.map((t) => `tool ${t}`), ...adds.context.map((c) => `context ${c}`),
      ...(adds.homePrivate ? ['Private Home'] : []), ...adds.homePrivateSidecars.map((s) => `Private Home for sidecar ${s}`),
      ...(adds.instanceScope ? [`instance scope ${adds.instanceScope}`] : []),
      ...Object.entries(adds.networks ?? {}).map(([s, n]) => `${s}: ${n} network`),
      ...(adds.resources ? [`resources ${JSON.stringify(adds.resources)}`] : []),
      ...(adds.runAsRoot ? ['runs as root'] : []),
    ];
    if (lines.length) process.stderr.write(`This change needs the owner's approval for:\n${lines.map((l) => `  + ${l}\n`).join('')}`);
  }
  const removed = plan.grantDiff?.removed ?? [];
  if (removed.length) process.stderr.write(`It gives up:\n${removed.map((r) => `  - ${r}\n`).join('')}`);
  for (const c of plan.compatibility ?? []) for (const l of errorLines(c)) process.stderr.write(`${l}\n`);
  const behind = plan.dataStaysBehind ?? [];
  if (behind.length) process.stderr.write(`Stays behind (not copied):\n${behind.map((d) => `  · ${d.where}: ${d.why}\n`).join('')}`);
  process.stderr.write(color.dim(`${plan.note ?? 'Data stays where it is: nothing is copied between environments.'}\n`));
}

// ── commands ────────────────────────────────────────────────────────────────

export function registerAppSetup(app: Command): void {
  app
    .command('setup <app>')
    .description('Set up an app that declares setup or operating profiles (resumes where it stopped).')
    .option('--profile <id>', 'the operating profile (required non-interactively when the app has more than one feasible profile)')
    .option('--values <file>', 'a JSON file of field values')
    .option('--secret <field=@vault:handle>', 'a secret field by vault handle (repeatable)', collect)
    .option('--resume', 'continue an interrupted setup at its recorded step')
    .option('-o, --output <format>', 'json for machine-readable output')
    .action(async (appId: string, opts: { profile?: string; values?: string; secret?: string[]; resume?: boolean; output?: string }) => {
      const out = outputOf(opts.output);
      if (opts.resume) {
        if (opts.profile || opts.values || opts.secret?.length) {
          exitWith(EXIT_INVALID_INPUT, '--resume continues the recorded run: drop --profile, --values and --secret (or run without --resume)');
        }
        return finish(appId, await call('POST', setupPath(appId, '/resume'), {}), out);
      }
      const secrets = parseSecrets(opts.secret);
      const values = opts.values ? readValuesFile(opts.values) : undefined;
      await refuseSecretValues(appId, values);
      const proposal: SetupProposal = {
        ...(opts.profile ? { profile: opts.profile } : {}),
        ...(values ? { values } : {}),
        ...(Object.keys(secrets).length ? { secrets } : {}),
      };
      return finish(appId, await call('POST', setupPath(appId, '/apply'), proposal), out);
    });

  const config = app.command('config').description('Read or change an app\'s setup values (secrets show as handles only).');
  config
    .command('get <app>')
    .description('Show the desired and effective setup values, the state and what is degraded.')
    .option('-o, --output <format>', 'json for machine-readable output')
    .action(async (appId: string, opts: { output?: string }) => {
      const out = outputOf(opts.output);
      const state = await getView<SetupStateView>(setupPath(appId), out);
      const values = await getView<SetupValuesView>(setupPath(appId, '/values'), out);
      if (out.json) printJson({ state, values });
      else printValues(appId, state, values);
    });
  config
    .command('set <app> [assignments...]')
    .description('Change plain setup values (field=value, a secret as field=@vault:<handle>); no approval. A change of privileges is refused here: use aura app setup or aura app profile use.')
    .option('--values <file>', 'a JSON file of field values')
    .option('--secret <field=@vault:handle>', 'a secret field by vault handle (repeatable)', collect)
    .option('-o, --output <format>', 'json for machine-readable output')
    .action(async (appId: string, assignments: string[], opts: { values?: string; secret?: string[]; output?: string }) => {
      const out = outputOf(opts.output);
      const fromArgs = parseAssignments(assignments ?? []);
      const values = { ...(opts.values ? readValuesFile(opts.values) : {}), ...fromArgs.values };
      const secrets = { ...parseSecrets(opts.secret), ...fromArgs.secrets };
      if (!Object.keys(values).length && !Object.keys(secrets).length) exitWith(EXIT_INVALID_INPUT, 'nothing to set: pass field=value, --values or --secret');
      await refuseSecretValues(appId, values);
      const proposal: SetupProposal = { ...(Object.keys(values).length ? { values } : {}), ...(Object.keys(secrets).length ? { secrets } : {}) };
      return finish(appId, await call('PUT', setupPath(appId, '/values'), proposal), out);
    });

  config
    .command('restore-last <app>')
    .description('Restore the last successfully applied configuration (revalidated; more privileges ask the owner). App data and outside effects are not rolled back.')
    .option('-o, --output <format>', 'json for machine-readable output')
    .action(async (appId: string, opts: { output?: string }) => {
      const out = outputOf(opts.output);
      const last = await getView<{ lastApplied: LastAppliedView | null; notice: string }>(setupPath(appId, '/restore'), out);
      if (!out.json) {
        if (!last.lastApplied) exitWith(EXIT_NEEDS_SETUP, `${appId} has no applied configuration to restore`);
        const l = last.lastApplied;
        process.stderr.write(`Restoring the configuration applied ${l.appliedAt}${l.profile ? ` (profile ${l.profile})` : ''}.\n`);
        process.stderr.write(color.yellow(`${last.notice}\n`));
      }
      return finish(appId, await call('POST', setupPath(appId, '/restore'), {}), out);
    });
  config
    .command('revoke-private-home <app>')
    .description('Revoke the Private Home you gave this app (with every sidecar grant, or one with --sidecar). The app becomes blocked; it never switches to its App Home.')
    .option('--sidecar <name>', 'revoke only this sidecar\'s grant')
    .option('-o, --output <format>', 'json for machine-readable output')
    .action(async (appId: string, opts: { sidecar?: string; output?: string }) => {
      const out = outputOf(opts.output);
      const q = opts.sidecar !== undefined ? `?sidecar=${encodeURIComponent(opts.sidecar)}` : '';
      const a = await call('DELETE', setupPath(appId, `/home-private${q}`));
      if (a.status !== 200) refuse(a, out);
      const r = a.body as { revoked: string[]; state: SetupStateView };
      if (out.json) { printJson(r); return; }
      if (!r.revoked.length) { process.stderr.write(`${appId} holds no Private Home grant of yours${opts.sidecar ? ` for sidecar ${opts.sidecar}` : ''}.\n`); return; }
      process.stderr.write(`${color.green('✓')} revoked ${r.revoked.join(', ')}; ${appId} is ${r.state.state}\n`);
    });
  config
    .command('private-home <app>')
    .description('List the Private Home grants you gave this app.')
    .option('-o, --output <format>', 'json for machine-readable output')
    .action(async (appId: string, opts: { output?: string }) => {
      const out = outputOf(opts.output);
      const grants = await getView<HomePrivateGrantView[]>(setupPath(appId, '/home-private'), out);
      if (out.json) { printJson(grants); return; }
      if (!grants.length) { console.log(color.dim(`${appId} holds no Private Home grant of yours.`)); return; }
      for (const g of grants) console.log(g.sidecar ? `home.private.sidecar:${g.sidecar}  (sidecar ${g.sidecar})` : 'home.private  (the app)');
    });

  const profile = app.command('profile').description('List or change an app\'s operating profile.');
  profile
    .command('ls <app>')
    .alias('list')
    .description('List the app\'s operating profiles, which are available here and why not.')
    .option('-o, --output <format>', 'json for machine-readable output')
    .action(async (appId: string, opts: { output?: string }) => {
      const out = outputOf(opts.output);
      const profiles = await getView<ProfileOption[]>(setupPath(appId, '/profiles'), out);
      if (out.json) { printJson(profiles); return; }
      const state = await getView<SetupStateView>(setupPath(appId), out);
      if (!profiles.length) { console.log(color.dim(`${appId} has no operating profiles.`)); return; }
      console.log(table(profiles.map((p) => ({
        '': p.id === state.profile ? '*' : '',
        ID: p.id,
        TITLE: `${p.title}${p.recommended ? color.dim(' (recommended)') : ''}`,
        AVAILABLE: p.available ? color.green('yes') : color.red('no'),
        WHY: p.available ? '' : p.reasons.map((r) => r.message).join('; '),
      })), ['', 'ID', 'TITLE', 'AVAILABLE', 'WHY']));
    });
  profile
    .command('use <app> <profile>')
    .description('Switch to another operating profile (shows what changes; data stays where it is). More privileges ask the owner.')
    .option('--values <file>', 'a JSON file of field values')
    .option('-o, --output <format>', 'json for machine-readable output')
    .action(async (appId: string, profileId: string, opts: { values?: string; output?: string }) => {
      const out = outputOf(opts.output);
      const values = opts.values ? readValuesFile(opts.values) : undefined;
      await refuseSecretValues(appId, values);
      const proposal: SetupProposal = { profile: profileId, ...(values ? { values } : {}) };
      if (!out.json) {
        const plan = await call('POST', setupPath(appId, '/change'), proposal);
        if (plan.status !== 200) refuse(plan, out);
        printPlanChanges(plan.body as SetupChangePlan);
      }
      return finish(appId, await call('POST', setupPath(appId, '/reconfigure'), proposal), out);
    });
}
