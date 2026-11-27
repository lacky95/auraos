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

// ── The operational gate (D108 A1/A2): may this app start at all? ────────────

/**
 * Manifest keys reserved for D108 (operating profiles, app setup). The schema
 * keeps them (opaque, never interpreted) so they are never dropped silently;
 * until the setup engine exists an app that declares one is refused, not run
 * unconfigured (fail closed).
 */
export const RESERVED_SETUP_KEYS = ['setup', 'profiles'] as const;
export type ReservedSetupKey = (typeof RESERVED_SETUP_KEYS)[number];

/** D105 categories a gate refusal carries (a subset of the error contract's `ErrorCategory`). */
export type OperationalBlockCategory = 'unsupported-operation' | 'unsupported-feature';

/**
 * Why an app may not start, as a D105 error body (plain data: what an API
 * answers, the CLI prints and the shell shows). `state` is the operational
 * state the beta setup engine reports (`blocked` here: nothing on this
 * AuraOS can make it startable; `setup-required` is reserved for the engine).
 */
export interface OperationalBlock {
  error: 'contract-unsupported' | 'setup-unsupported';
  category: OperationalBlockCategory;
  state: 'blocked' | 'setup-required';
  message: string;
  hint: string;
  /** The manifest field that causes it. */
  manifestField: string;
  target: string;
}

/** The reserved D108 keys a manifest declares (in RESERVED_SETUP_KEYS order). */
export function declaredSetupKeys(manifest: Partial<Record<ReservedSetupKey, unknown>>): ReservedSetupKey[] {
  return RESERVED_SETUP_KEYS.filter((k) => manifest[k] !== undefined && manifest[k] !== null);
}

/**
 * The one start predicate (D108 A2, D36): null when the app may start, else
 * why not. Evaluated at the spawn choke point (AppManager `spawnContext`), by
 * the boot, enable and pool loops (which skip a blocked app), by `startIntent`
 * (the `setup-required` result), at install (422) and by `aura dev validate`.
 * Today: an unknown `auraContract` major, then a reserved D108 key. Apps
 * with neither start exactly as before.
 */
export function operationalBlock(manifest: { id: string; auraContract?: number | null } & Partial<Record<ReservedSetupKey, unknown>>): OperationalBlock | null {
  const major = contractRefusal(manifest);
  if (major) {
    return {
      error: major.code, category: 'unsupported-operation', state: 'blocked', message: major.message, target: manifest.id,
      hint: `update AuraOS, or install a version of ${manifest.id} built for Aura contract ${major.implemented}`, manifestField: 'auraContract',
    };
  }
  const keys = declaredSetupKeys(manifest);
  if (keys.length === 0) return null;
  return {
    error: 'setup-unsupported', category: 'unsupported-feature', state: 'blocked', target: manifest.id,
    message: `${manifest.id} declares ${keys.join(' and ')} (operating profiles and app setup, D108); this AuraOS has no setup engine yet, so it does not start the app unconfigured`,
    hint: `install a version of ${manifest.id} without ${keys.join('/')}, or update AuraOS to a release with app setup`,
    manifestField: keys[0]!,
  };
}

/** A refused start, as an error that carries its D105 body (`code` for clients that branch without `instanceof`). */
export class OperationalBlockError extends Error {
  override readonly name = 'OperationalBlockError';
  readonly code: OperationalBlock['error'];
  constructor(readonly body: OperationalBlock) {
    super(body.message);
    this.code = body.error;
  }
}

/** The D105 body of a refused start, from any error, or null. */
export function operationalBlockOf(err: unknown): OperationalBlock | null {
  const b = (err as { body?: OperationalBlock } | null)?.body;
  return err instanceof Error && b && (b.error === 'contract-unsupported' || b.error === 'setup-unsupported') && typeof b.message === 'string' ? b : null;
}
