/**
 * The one structured error body of AuraOS (error-messages review §4.1).
 * Additive over the existing `{error: <code>, message?, details?}` convention
 * the SDK already reads: `error` stays the closed code clients branch on,
 * everything else is optional and present only when it applies AND the caller
 * may know it (review §4.4):
 *   - only what the caller can already know: its own manifest and
 *     permissions, the route's rule, a target only when the caller named it;
 *   - never a grant command for something nobody can grant (owner-only
 *     routes, `admin.*`, a system app's shipped permissions);
 *   - no credentials, tokens, env values or internal host paths;
 *   - a token failure stays one class (`unauthenticated`): no detail on
 *     which check failed.
 *
 * Produced by one builder in the shell (`lib/appResponse.ts`
 * `errorResponse(status, body)`), read by one SDK decoder (`osErrorFrom`)
 * and one CLI formatter (`formatShellError`). First created by D104 (app
 * composition); Pass A of the error-messages review extends it.
 *
 * Leaf contract (D97): no runtime imports.
 */

/** Who has to hold what is missing. */
export type AuraErrorHolder =
  /** the caller: its own manifest has to declare it */
  | 'caller'
  /** the app the call acts on has to hold it */
  | 'target'
  /** declared, but the owner has not granted it (privileged permissions) */
  | 'owner-grant';

/**
 * What a client may do about an error, without parsing its message. The
 * runtime layer's D100 §17 categories, plus the access layer's, which tell
 * apart the five kinds of refusal the owner asked to distinguish:
 *
 *   missing-declaration  the caller's app.manifest.json does not declare it
 *   missing-permission   a permission is not held (the owner's grant, or the target's)
 *   needs-approval       the owner (or the host operator) has to approve this request
 *   unsupported-feature  / unsupported-operation: not something this caller can do here
 *   not-grantable        a policy restriction nobody can grant (owner-only, own instance only, …)
 *
 * D109 AF4 (D105 Pass B): a request the caller can fix by itself, before any
 * policy is asked:
 *   missing-input        a required input is absent; `missing[]` names each one (`MissingInput`)
 *   invalid-input        an input is present but not acceptable; `missing[]` may name it, `details` says why
 */
export type ErrorCategory =
  // D100 §17 (runtime refusals)
  | 'unsupported-operation' | 'unsupported-feature' | 'permission-denied' | 'runtime-unavailable'
  | 'instance-not-found' | 'resource-exhausted' | 'restart-required' | 'recreate-required'
  | 'provisioning-failed' | 'enforcement-failed' | 'operation-timeout' | 'operation-cancelled' | 'conflict'
  // access and requests
  | 'not-authenticated' | 'missing-declaration' | 'missing-permission' | 'needs-approval' | 'not-grantable'
  | 'invalid-request' | 'not-found' | 'unavailable'
  // inputs (D109 AF4)
  | 'missing-input' | 'invalid-input';

/**
 * One input of a `missing-input` / `invalid-input` error (D109 AF4): what the
 * caller has to supply, and in which form. A machine reader (an agent in the
 * CLI's agent mode, D109) completes the request from these; a human reads the
 * `message`.
 */
export interface MissingInput {
  /** The input's name as the caller spells it: a body field (`files`), an argument (`appId`), a flag (`--scope`). */
  input: string;
  kind: 'argument' | 'option' | 'field' | 'file';
  /** What is accepted, in a few words: "reverse-domain id, e.g. com.example.notes". */
  expects: string;
}

export interface AuraErrorBody {
  /** Stable closed code (kebab). What clients branch on. */
  error: string;
  /** One human sentence: what was refused and why. Never parsed. */
  message: string;
  /** Access layer: an `AccessReason` of the shell's access policy (missing-permission, wrong-target, …). */
  reason?: string;
  /** What a client may do about it (see ErrorCategory). */
  category?: ErrorCategory;
  /** The fix, one line: an exact manifest edit, `aura …` command, Settings path or approval step. */
  hint?: string;
  /** Where the docs explain it. */
  docs?: string;
  /** The permission that is missing, e.g. 'apps.mount'. */
  permission?: string;
  holder?: AuraErrorHolder;
  /** A capability or tool name ('git'). */
  capability?: string;
  /** Runtime capabilities that are missing (runtime refusals), or the inputs of a missing-input / invalid-input error. */
  missing?: Array<string | MissingInput>;
  /** Named alternatives, never picked for the caller (D73). */
  suggest?: string[];
  /** JSON path in app.manifest.json: 'permissions[]', 'composition.view', … */
  manifestField?: string;
  /** A security option id of the D64 registry, e.g. 'fresh-auth-require-https'. */
  policy?: string;
  /** An app id, only when the caller named it (or it is the caller's own). */
  target?: string;
  /** needs-approval: the request the owner decides. */
  approvalId?: string;
  details?: unknown;
}
