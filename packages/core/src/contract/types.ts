/**
 * The contract majors this AuraOS implements, and the one refusal of a newer
 * major (D48; D36: one helper for every versioned contract).
 *
 * A leaf contract file (D97 `contract-leaf`): it imports nothing, so the app
 * contract (appContract.ts), the ARI (runtimes/ari.ts), the installer, the
 * registry and the CLI share it without a cycle.
 *
 * Phase 6 refuses an unknown major wherever code meets this AuraOS: an app
 * built for a newer `auraContract` is refused at install and patch activation,
 * listed `incompatible` and never started; a runtime module needing a newer
 * ARI is refused at registration (5b, ARI §4.3). A missing `auraContract`
 * (`none`, apps from before the contract) stays allowed.
 */

/** The contract this AuraOS implements. The SDK exports the same value (`AURA_CONTRACT`). */
export const AURA_CONTRACT = 1;

/** Which contract an app was built for: `none` before the contract, `incompatible` for a newer major. */
export type ContractStatus = 'current' | 'none' | 'incompatible';

/** The versioned contracts with a major: the app contract and the Aura Runtime Interface. */
export type ContractKind = 'auraContract' | 'ari';

const MAJOR_REFUSALS = {
  auraContract: {
    code: 'contract-unsupported',
    message: (subject: string, declared: number, implemented: number) =>
      `${subject} is built for Aura contract ${declared}; this AuraOS implements ${implemented}. Update AuraOS or install a version built for contract ${implemented}.`,
  },
  ari: {
    code: 'ari-unsupported',
    message: (subject: string, declared: number, implemented: number) =>
      `runtime ${subject} needs ARI ${declared} (this AuraOS implements ARI ${implemented})`,
  },
} as const;

/** The refusal code of an app built for a newer Aura contract (HTTP 422 on every install path). */
export const CONTRACT_UNSUPPORTED = MAJOR_REFUSALS.auraContract.code;

export interface MajorRefusal<K extends ContractKind = ContractKind> {
  kind: K;
  code: (typeof MAJOR_REFUSALS)[K]['code'];
  /** The app id or runtime id. */
  subject: string;
  declared: number;
  implemented: number;
  message: string;
}

/**
 * The refusal of a declared major above the implemented one, or null. The
 * one comparison and message of every contract major (an app's
 * `auraContract`, a runtime module's `ari`); each caller turns it into its
 * own error shape (HTTP 422, `RuntimeModuleError`, a validate error) with
 * this code and message, and audits it in its own trail.
 */
export function refuseUnknownMajor<K extends ContractKind>(kind: K, subject: string, declared: number, implemented: number): MajorRefusal<K> | null {
  if (!(declared > implemented)) return null;
  const shape = MAJOR_REFUSALS[kind];
  return { kind, code: shape.code as MajorRefusal<K>['code'], subject, declared, implemented, message: shape.message(subject, declared, implemented) };
}

/** An app's contract refusal (`auraContract` above `AURA_CONTRACT`), or null; `none` is never refused. */
export function contractRefusal(manifest: { id: string; auraContract?: number | null }): MajorRefusal<'auraContract'> | null {
  const v = manifest.auraContract ?? null;
  return v === null ? null : refuseUnknownMajor('auraContract', manifest.id, v, AURA_CONTRACT);
}

/** The audit action of a refused app (kernel, at registry load); the runtime twin is `runtime.module-refused`. */
export const CONTRACT_AUDIT_ACTIONS = {
  refused: 'app.contract-refused',
} as const;
