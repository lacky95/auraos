/**
 * The contract majors this AuraOS implements, and the one refusal of a newer
 * major (D48; D36: one helper for every versioned contract).
 *
 * A leaf contract file (D97 `contract-leaf`): it imports only types (the D105
 * error body, `errors/contracts.ts`), so the app
 * contract (appContract.ts), the ARI (runtimes/ari.ts), the installer, the
 * registry and the CLI share it without a cycle.
 *
 * Phase 6 refuses an unknown major wherever code meets this AuraOS: an app
 * built for a newer `auraContract` is refused at install and patch activation,
 * listed `incompatible` and never started; a runtime module needing a newer
 * ARI is refused at registration (5b, ARI §4.3). A missing `auraContract`
 * (`none`, apps from before the contract) stays allowed.
 */

import type { AuraErrorBody, ErrorCategory } from '../errors/contracts.js';
import type { OperationalState } from '../setup/contracts.js';

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
 * The D108 manifest keys (operating profiles, app setup). The schema keeps
 * them (never dropped silently); the setup engine's gate decides whether an
 * app that declares one starts (`setupEngineMissing` without the engine).
 */
export const RESERVED_SETUP_KEYS = ['setup', 'profiles'] as const;
export type ReservedSetupKey = (typeof RESERVED_SETUP_KEYS)[number];

/**
 * Why an app may not start: the one D105 error body (`errors/contracts.ts`
 * `AuraErrorBody`, plain data: what an API answers, the CLI formats and the
 * shell shows), narrowed to what the gate always fills in. `details.state`
 * is the operational state (D108 `OperationalState`).
 *
 *   contract-unsupported   a newer `auraContract` major (`operationalBlock`)
 *   setup-required | setup-blocked | repair-required
 *                          the setup engine's gate (category `needs-setup`,
 *                          setup/service.ts): the state is not `ready`, or
 *                          the stored configDigest is not the resolved one
 *   setup-unsupported      a kernel composed without the setup engine refuses
 *                          an app that declares setup/profiles (fail closed,
 *                          `setupEngineMissing`)
 */
export interface OperationalBlock extends AuraErrorBody {
  error: 'contract-unsupported' | 'setup-unsupported' | 'setup-required' | 'setup-blocked' | 'repair-required';
  category: Extract<ErrorCategory, 'unsupported-operation' | 'unsupported-feature' | 'needs-setup'>;
  message: string;
  hint: string;
  docs: string;
  /** The manifest field that causes it. */
  manifestField: string;
  target: string;
  /** `needs-setup`: the operational state, also at the top level like a setup body (setup/contracts.ts `SetupErrorBody.state`). */
  state?: OperationalState;
  details: { state: OperationalBlockState };
}

/**
 * The operational state a gate refusal reports: the D108 lifecycle's
 * (`setup/contracts.ts` `OperationalState`, one definition).
 */
export type OperationalBlockState = OperationalState;

/** The codes of a refused start (`operationalBlockOf`). */
const OPERATIONAL_BLOCK_CODES: ReadonlySet<string> = new Set(['contract-unsupported', 'setup-unsupported', 'setup-required', 'setup-blocked', 'repair-required']);

/** The Aura Docs page that explains the gate (the app contract). */
const GATE_DOCS = 'app-contract';

/** The reserved D108 keys a manifest declares (in RESERVED_SETUP_KEYS order). */
export function declaredSetupKeys(manifest: Partial<Record<ReservedSetupKey, unknown>>): ReservedSetupKey[] {
  return RESERVED_SETUP_KEYS.filter((k) => manifest[k] !== undefined && manifest[k] !== null);
}

/**
 * The one static start predicate (D108 A2, D36): null when nothing in the
 * manifest itself forbids a start, else why. Evaluated at the spawn choke
 * point (AppManager `spawnContext`), by the boot, enable and pool loops
 * (which skip a blocked app), by `startIntent` (the `setup-required`
 * result), at install (422) and by `aura dev validate`: an unknown
 * `auraContract` major. An app that declares setup or profiles is the setup
 * engine's (its gate in `spawnContext`, D108 P3), not refused here.
 */
export function operationalBlock(manifest: { id: string; auraContract?: number | null } & Partial<Record<ReservedSetupKey, unknown>>): OperationalBlock | null {
  const major = contractRefusal(manifest);
  if (!major) return null;
  return {
    error: major.code, category: 'unsupported-operation', message: major.message, target: manifest.id,
    hint: `update AuraOS, or install a version of ${manifest.id} built for Aura contract ${major.implemented}`, manifestField: 'auraContract',
    docs: GATE_DOCS, details: { state: 'blocked' },
  };
}

/**
 * The refusal of a kernel composed WITHOUT the setup engine (a unit test, a
 * composition that leaves it out): an app that declares setup or profiles
 * never starts unconfigured (D108 A1, fail closed). Null for every other app.
 */
export function setupEngineMissing(manifest: { id: string } & Partial<Record<ReservedSetupKey, unknown>>): OperationalBlock | null {
  const keys = declaredSetupKeys(manifest);
  if (keys.length === 0) return null;
  return {
    error: 'setup-unsupported', category: 'unsupported-feature', target: manifest.id, docs: GATE_DOCS, details: { state: 'blocked' },
    message: `${manifest.id} declares ${keys.join(' and ')} (operating profiles and app setup, D108); this AuraOS runs without its setup engine, so it does not start the app unconfigured`,
    hint: `install a version of ${manifest.id} without ${keys.join('/')}, or run AuraOS with its setup engine`,
    manifestField: keys[0]!,
  };
}

/** The Aura Docs page of app setup (D108). */
const SETUP_DOCS = 'app-setup';

/**
 * The setup gate's refusal (D108 §3.1, category `needs-setup`): the 409
 * body P6's launch opens the wizard on. Built by the engine
 * (setup/service.ts) and by AppManager for a start it can't place.
 */
export function setupGateBlock(
  appId: string, code: 'setup-required' | 'setup-blocked' | 'repair-required', state: OperationalState, message: string, hint: string, manifestField = 'setup',
): OperationalBlock {
  return { error: code, category: 'needs-setup', message, hint, docs: SETUP_DOCS, manifestField, target: appId, state, details: { state } };
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
  return err instanceof Error && b && OPERATIONAL_BLOCK_CODES.has(b.error) && typeof b.message === 'string' ? b : null;
}
