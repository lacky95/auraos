/**
 * The app-facing types of D108 app setup (mirror of @aura/core
 * setup/contracts.ts; kept local so the SDK has no runtime dependency on
 * core). Plain data:
 *
 *   SetupConfig      `osClient.setup.config()` (server-side, instance token):
 *                    the app's own effective values; secrets as D56 handles,
 *                    read with `credentials.get(handle)`
 *   SetupHookInput   what `onSetup` receives in a maintenance start
 *   ValidateResult   what `onValidate` answers (it cannot change state)
 *   MigrateConfig*   `onMigrateConfig` after declarative renames
 *
 * D108 P0: the types. The client (`osClient.setup`) is P4, the hook handlers
 * (`createSetupHandler`, `createValidateHandler`) are P3, both in setup.ts.
 */

export type SetupConfigValue = boolean | number | string | string[];

/** An unmet optional requirement: reported to the app, never satisfied by weakening. */
export interface SetupDegraded {
  requirement: Record<string, unknown>;
  reason: string;
}

export interface SetupConfig {
  appId: string;
  installationId: string;
  /** The selected operating profile, or null for an app without profiles. */
  profile: string | null;
  values: Record<string, SetupConfigValue>;
  /** field → vault handle. */
  secrets: Record<string, string>;
  degraded: SetupDegraded[];
  configDigest: string;
}

export type SetupReason = 'setup' | 'reconfigure' | 'repair' | 'migrate';

/** `onSetup` input. The hook must be idempotent: AuraOS may call it again with the same digest. */
export interface SetupHookInput {
  configDigest: string;
  previousDigest: string | null;
  attempt: number;
  reason: SetupReason;
}

export interface ValidateResult {
  ok: boolean;
  fieldErrors?: Record<string, string>;
  checks?: Array<{ id: string; ok: boolean; message?: string }>;
}

export interface MigrateConfigInput { fromVersion: number; toVersion: number; values: Record<string, SetupConfigValue> }
export interface MigrateConfigResult { values: Record<string, SetupConfigValue> }
