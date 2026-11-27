/**
 * Value delivery (D108 P4, review §2.2 "Values reach code by reference
 * only", decision 7): how an effective configuration reaches the app and
 * its sidecars. No templating: a value goes where a manifest REFERENCES it.
 *
 *   the app server   `setupConfigView()` → `GET /api/setup/self` → SDK
 *                    `osClient.setup.config()`: the active fields' values,
 *                    secrets as D56 handles (read with `credentials.get`).
 *   sidecars         `sidecarSetupValues()`: the `services[].env` references
 *                    of the effective service template, resolved at spawn
 *                    (app-manager/sidecar-spec.ts `SpecEnvResolver`):
 *                      { fromSetup, map? }  the plain value as a literal
 *                      { fromSecret }       a REFERENCE (field, handle) in the
 *                                           spec; the value is read from the
 *                                           vault server-side only when the
 *                                           container is created
 *
 * Literal rules (deterministic, never a passthrough):
 *   - string → as is; boolean → `true`/`false`; integer → its decimal form.
 *   - `map` present: the literal is `map[<that string>]`; a value with no
 *     entry is a `config-invalid` refusal, never the raw value.
 *   - array: refused (`config-invalid`). A list has no single env form
 *     without a join rule, and a join rule would be templating; `map` keys
 *     are single strings, so a map can't name a list either.
 *   - a field that is not active (`when` false) or has no value (an unset
 *     optional field, an absent optional secret): the variable is not set.
 *     A required active field always has a value, or there is no effective
 *     configuration at all (resolve.ts) and so no resolver.
 *
 * A secret value is never in the spec, its hash, a record, an error, an
 * audit entry or a log: the spec carries `{field, handle}` (that is what the
 * spec hash covers), and the value goes only into the container's env.
 *
 * A sidecar gets a secret only through its app's own handle: the handle must
 * resolve in the installation owner's vault to THIS app, and either be the
 * installation's generated secret (bound to this installation) or the app
 * must hold a counting `credential.read:<NAME>` grant, exactly as the app's
 * own `credentials.get` would (`secretReadableWithoutGrant`, the shell's
 * lib/credentials.ts uses the same rule).
 */
import type { CredentialVault, SetupSecretBinding } from '../context/CredentialVault.js';
import type { ConfigField, ConfigValue } from '../config/schema.js';
import type { EnvValue, FromSetupRef } from '../types/setupManifest.js';
import type { AuditInput } from '../auth/AdminAudit.js';
import type { SecretEnvRef, SidecarSetupValues } from '../app-manager/sidecar-spec.js';
import { setupError, type EffectiveConfig, type SetupConfigView, type SetupErrorBody } from './contracts.js';

/** A value that can't become an env literal (D105 `config-invalid`; names the field, never the value). */
export class SetupValueError extends Error {
  readonly code = 'config-invalid' as const;
  constructor(readonly body: SetupErrorBody) { super(body.message); this.name = 'SetupValueError'; }
}

// ── the app server ──────────────────────────────────────────────────────────

/** The app's own view of its effective configuration (`/api/setup/self`): values, secrets as handles. */
export function setupConfigView(effective: EffectiveConfig): SetupConfigView {
  return {
    appId: effective.appId,
    installationId: effective.installationId,
    profile: effective.profile,
    values: structuredClone(effective.values),
    secrets: { ...effective.secrets },
    degraded: structuredClone(effective.degraded),
    configDigest: effective.configDigest,
  };
}

// ── env literals ────────────────────────────────────────────────────────────

/**
 * The env literal of a plain setup value under a `fromSetup` reference
 * (`env` names the variable for the error). Throws SetupValueError.
 */
export function setupEnvLiteral(value: ConfigValue, ref: FromSetupRef, env: string): string {
  const field = ref.fromSetup;
  let s: string;
  if (typeof value === 'string') s = value;
  else if (typeof value === 'boolean') s = value ? 'true' : 'false';
  else if (typeof value === 'number' && Number.isSafeInteger(value)) s = String(value);
  else {
    throw new SetupValueError(setupError('config-invalid',
      `env ${env}: setup field ${field} holds a ${Array.isArray(value) ? 'list' : 'value'} that has no env form (a list is never joined; use a string or enum field)`,
      { manifestField: `setup.fields.${field}` }));
  }
  if (!ref.map) return s;
  if (!Object.prototype.hasOwnProperty.call(ref.map, s)) {
    throw new SetupValueError(setupError('config-invalid',
      `env ${env}: the value of setup field ${field} has no entry in the reference's map (never passed through)`,
      { manifestField: `setup.fields.${field}` }));
  }
  return ref.map[s]!;
}

// ── sidecars ────────────────────────────────────────────────────────────────

/** Reads a secret value by the app's handle, server-side; null when it is not this app's to read. */
export type SecretReader = (handle: string) => Promise<string | null>;

/**
 * The sidecar env resolver of an effective configuration. The env of a
 * template is the effective service's (the profile overlay applied), else
 * the template's own.
 */
export function sidecarSetupValues(effective: EffectiveConfig, readSecret: SecretReader): SidecarSetupValues {
  return {
    env(template: string, base: Record<string, EnvValue>) {
      const source = effective.services.find((s) => s.name === template)?.env ?? base;
      const env: Record<string, string> = {};
      const secretEnv: Record<string, SecretEnvRef> = {};
      for (const [k, v] of Object.entries(source)) {
        if (typeof v === 'string') { env[k] = v; continue; }
        if ('fromSecret' in v) {
          const handle = effective.secrets[v.fromSecret];
          if (typeof handle === 'string') secretEnv[k] = { field: v.fromSecret, handle };
          continue;
        }
        const value = effective.values[v.fromSetup];
        if (value !== undefined) env[k] = setupEnvLiteral(value, v, k);
      }
      return { env, secretEnv };
    },
    readSecret,
  };
}

/**
 * A generated setup secret of THIS installation needs no `credential.read`
 * grant: nobody typed it, and it exists only for this installation's app.
 * Anything else read by an app (a secret the owner typed or picked) needs
 * the owner's grant. One rule for the kernel and the shell.
 */
export function secretReadableWithoutGrant(held: { installation?: SetupSecretBinding }, installationId: string | null | undefined): boolean {
  return !!installationId && held.installation?.installationId === installationId;
}

export interface VaultSecretReaderOptions {
  vault: Pick<CredentialVault, 'resolve' | 'reveal'>;
  /** The vault the installation's secrets are in (the installation owner's; alpha: the owner). */
  userId: string;
  appId: string;
  installationId: string;
  /** Does `appId` hold a counting `credential.read:<name>` grant in `userId`'s vault (GrantStore + appGrantCounts)? */
  readGranted(name: string): Promise<boolean>;
  /** The `vault.read` audit entry (no value). */
  audit?(entry: AuditInput): Promise<void>;
}

/** The server-side secret read of a sidecar spawn: the app's own handle, or nothing. */
export function vaultSecretReader(o: VaultSecretReaderOptions): SecretReader {
  return async (handle) => {
    const held = await o.vault.resolve(o.userId, handle);
    if (!held || held.consumer !== o.appId) return null;
    if (!secretReadableWithoutGrant(held, o.installationId) && !(await o.readGranted(held.name))) return null;
    const value = await o.vault.reveal(o.userId, held.name, o.appId);
    try {
      await o.audit?.({
        by: { kind: 'system' }, action: 'vault.read', target: `vault:${held.name}`, outcome: value === null ? 'failed' : 'ok',
        detail: { name: held.name, app: o.appId, installation: o.installationId, user: o.userId, via: 'setup-env' },
      });
    } catch { /* the audit trail must not fail the spawn */ }
    return value;
  };
}

// ── generated secrets ───────────────────────────────────────────────────────

/**
 * The handles of the `generate` secret fields among `fields` that `have`
 * lacks, created by the vault for (installation, field) in `userId`'s vault
 * (idempotent: an existing one is returned). The engine (P3) stores the
 * handles in the desired record (`updatedBy: kernel`). No value leaves the
 * vault.
 */
export async function generateSetupSecrets(
  vault: Pick<CredentialVault, 'generate'>,
  o: { userId: string; appId: string; installationId: string; fields: Readonly<Record<string, ConfigField>>; have: Readonly<Record<string, string>> },
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, f] of Object.entries(o.fields).sort(([a], [b]) => a.localeCompare(b))) {
    if (f.type !== 'secret' || f.secret.source !== 'generate' || name in o.have) continue;
    out[name] = (await vault.generate(o.userId, {
      consumer: o.appId, installationId: o.installationId, field: name, ...(f.secret.length !== undefined ? { length: f.secret.length } : {}),
    })).handle;
  }
  return out;
}
