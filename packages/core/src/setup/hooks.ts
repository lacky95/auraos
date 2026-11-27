/**
 * The app's setup hooks (D108 decision 8, §3.4, §4): `onSetup`, `onValidate`
 * and (reserved for P8) `onMigrateConfig`, called in a maintenance start with
 * reason `setup` (Phase 6 M, the frozen `MaintenanceStarter` port of
 * `app-manager/maintenance.ts`): the app's own server, its identity and
 * lifecycle token, no traffic routed, no owner session, no approvals.
 *
 *   runSetupHooks   start → `onSetup({configDigest, previousDigest, attempt,
 *                   reason})` when `setup.init.hook` (timeout
 *                   `setup.init.timeoutSec`) → `onValidate` when
 *                   `setup.readiness.hook` → stop. Never serves.
 *   migrateConfig   the `onMigrateConfig` call shape (P8 builds the flow).
 *
 * Fail closed: an app that declares a hook on a kernel without the
 * maintenance start, a refused start, a hook error, a missing hook, a
 * timeout or `ok: false` is a `setup-failed` D105 body. The app's own words
 * are quoted and labelled as the app's, bounded, one line; never ready
 * without the hook.
 */
import type { MaintenanceSession, MaintenanceStarter } from '../app-manager/maintenance.js';
import {
  setupError, type MigrateConfigInput, type MigrateConfigResult, type SetupErrorBody, type SetupHookInput, type ValidateResult,
} from './contracts.js';
import type { SetupAppManifest } from './ports.js';

const DEFAULT_INIT_TIMEOUT_SEC = 300;
const VALIDATE_TIMEOUT_MS = 60_000;
const MAX_APP_WORDS = 300;

/** The hint of a hook-bearing app on a kernel without the maintenance start (6B.M). */
export const NO_MAINTENANCE_HINT = 'it needs the maintenance start of this release (Phase 6 M, reason setup); until then the app stays not ready';

export class SetupHookError extends Error {
  readonly code: string;
  constructor(readonly body: SetupErrorBody) { super(body.message); this.name = 'SetupHookError'; this.code = body.error; }
}

/** The app's words, as a quoted label: one line, bounded, never parsed. */
export function appWords(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : raw === undefined || raw === null ? '' : JSON.stringify(raw);
  const one = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  return one.length > MAX_APP_WORDS ? `${one.slice(0, MAX_APP_WORDS - 1)}…` : one;
}

/** Does the app declare a hook the setup has to call? */
export function needsHooks(m: Pick<SetupAppManifest, 'setup'>): boolean {
  return m.setup?.init?.hook === true || m.setup?.readiness?.hook === true;
}

function failed(appId: string, message: string, extra: Partial<Omit<SetupErrorBody, 'error' | 'category'>> = {}, code: 'setup-failed' | 'hook-failed' = 'setup-failed'): SetupHookError {
  return new SetupHookError(setupError(code, message, { state: 'setup-failed', target: appId, ...extra }));
}

async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** An `ok: false` (or an error field) in a hook's answer, as the app's words; null when it succeeded. */
function hookRefusal(answer: unknown): string | null {
  if (!answer || typeof answer !== 'object') return null;
  const a = answer as { ok?: unknown; error?: unknown; message?: unknown };
  if (a.ok === false) return appWords(a.message ?? a.error ?? 'no reason given');
  return null;
}

function validateOf(answer: unknown): ValidateResult | null {
  if (!answer || typeof answer !== 'object' || typeof (answer as { ok?: unknown }).ok !== 'boolean') return null;
  const a = answer as ValidateResult;
  const fieldErrors: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.fieldErrors ?? {})) if (typeof k === 'string' && k.length <= 64) fieldErrors[k] = appWords(v);
  const checks = Array.isArray(a.checks)
    ? a.checks.filter((c) => c && typeof c.id === 'string').slice(0, 32).map((c) => ({ id: appWords(c.id).slice(0, 64), ok: c.ok === true, ...(c.message !== undefined ? { message: appWords(c.message) } : {}) }))
    : [];
  return { ok: a.ok, ...(Object.keys(fieldErrors).length ? { fieldErrors } : {}), ...(checks.length ? { checks } : {}) };
}

export interface RunSetupHooksInput {
  appId: string;
  manifest: Pick<SetupAppManifest, 'setup'>;
  userId: string;
  hook: SetupHookInput;
  starter: MaintenanceStarter | null;
}

/**
 * Run the declared hooks once. Resolves when init and readiness succeeded
 * (or the app declares none); throws `SetupHookError` otherwise. The
 * maintenance start is always finished with `stop`.
 */
export async function runSetupHooks(i: RunSetupHooksInput): Promise<{ validate: ValidateResult | null }> {
  if (!needsHooks(i.manifest)) return { validate: null };
  const label = i.appId;
  if (!i.starter) {
    throw failed(label, `${label} declares a setup hook (setup.init or setup.readiness), and this AuraOS cannot run it yet`, { hint: NO_MAINTENANCE_HINT });
  }
  const timeoutMs = (i.manifest.setup?.init?.timeoutSec ?? DEFAULT_INIT_TIMEOUT_SEC) * 1000;
  let started;
  try {
    started = await i.starter.startMaintenance(i.appId, { reason: 'setup', userId: i.userId, hookTimeoutMs: timeoutMs });
  } catch (err) {
    throw failed(label, `the maintenance start of ${label} failed: ${appWords(err)}`);
  }
  if (!started.ok) {
    throw failed(label, `the maintenance start of ${label} was refused: ${appWords(started.error.message)}`, started.error.hint ? { hint: started.error.hint } : {});
  }
  const session: MaintenanceSession = started.session;
  try {
    if (i.manifest.setup?.init?.hook === true) {
      let answer: unknown;
      try {
        answer = await withTimeout(session.callHook('onSetup', i.hook), timeoutMs,
          () => failed(label, `${label}'s onSetup did not finish within ${Math.round(timeoutMs / 1000)} s`));
      } catch (err) {
        if (err instanceof SetupHookError) throw err;
        throw failed(label, `${label}'s onSetup failed. The app says: "${appWords(err)}"`, {}, 'hook-failed');
      }
      if (answer === null || answer === undefined) throw failed(label, `${label} declares setup.init.hook but serves no onSetup`);
      const refused = hookRefusal(answer);
      if (refused !== null) throw failed(label, `${label}'s onSetup failed. The app says: "${refused}"`, {}, 'hook-failed');
    }
    let validate: ValidateResult | null = null;
    if (i.manifest.setup?.readiness?.hook === true) {
      let answer: unknown;
      try {
        answer = await withTimeout(session.callHook('onValidate', { configDigest: i.hook.configDigest }), VALIDATE_TIMEOUT_MS,
          () => failed(label, `${label}'s onValidate did not answer within ${VALIDATE_TIMEOUT_MS / 1000} s`));
      } catch (err) {
        if (err instanceof SetupHookError) throw err;
        throw failed(label, `${label}'s onValidate failed. The app says: "${appWords(err)}"`, {}, 'hook-failed');
      }
      validate = validateOf(answer);
      if (!validate) throw failed(label, `${label} declares setup.readiness.hook but serves no valid onValidate answer`);
      if (!validate.ok) {
        const why = [...Object.entries(validate.fieldErrors ?? {}).map(([f, m]) => `${f}: ${m}`), ...(validate.checks ?? []).filter((c) => !c.ok).map((c) => `${c.id}${c.message ? `: ${c.message}` : ''}`)];
        throw failed(label, `${label}'s readiness check failed. The app says: "${appWords(why.join('; ') || 'not ready')}"`,
          validate.fieldErrors ? { fieldErrors: validate.fieldErrors } : {});
      }
    }
    return { validate };
  } finally {
    await session.finish('stop').catch(() => undefined);
  }
}

/** `onMigrateConfig` (P8 runs it after the declarative renames): the call shape only. */
export async function migrateConfig(session: Pick<MaintenanceSession, 'callHook'>, input: MigrateConfigInput): Promise<MigrateConfigResult> {
  const answer = await session.callHook('onMigrateConfig', input);
  const values = (answer as { values?: unknown } | null)?.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw failed('app', 'onMigrateConfig gave no values');
  return { values: values as MigrateConfigResult['values'] };
}
