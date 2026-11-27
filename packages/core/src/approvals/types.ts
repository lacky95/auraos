/**
 * The approval record (5.10, D16, D17, D31, D49): a sensitive action a
 * verified requester asks for, which the owner decides in the shell's own
 * dialog and the server consumes exactly once.
 *
 *   requester ──create──▶ pending ──approve──▶ approved ──consume──▶ consumed
 *                            │                    │
 *                            ├──deny──▶ denied    └──(expiresAt)──▶ expired
 *                            └──(expiresAt)──▶ expired
 *
 * `denied`, `consumed` and `expired` are final. Transitions are checked by the
 * pure `transitionApproval()` (state.ts); the store (`ApprovalStore`) applies
 * them atomically. The record binds the requester, the action and the payload
 * hash: consuming it with any other one is refused.
 *
 * Nothing here holds a credential: no token, cookie, password or proof.
 */
import type { AccessPrincipal } from '../auth/types.js';
import type { AuraApprovalLevel } from '../app-hosts/auraChannel.js';

/** One approval, from creation to its single use. */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;
/** Pending requests one requester may hold at a time (5.10 "No approval spam"). */
export const MAX_PENDING_PER_REQUESTER = 1;
/** How many times an approved record can be consumed. */
export const APPROVAL_USES = 1;

export const APPROVAL_LEVELS = ['session', 'fresh'] as const;
/**
 * `session`: an owner on an unlocked tab clicks Approve.
 * `fresh`: the owner also re-enters the password in the approve request (or
 * an operator approves on the host, D18).
 */
export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];

export const APPROVAL_STATES = ['pending', 'approved', 'denied', 'consumed', 'expired'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];
export const FINAL_APPROVAL_STATES: ReadonlySet<ApprovalState> = new Set(['denied', 'consumed', 'expired']);

/**
 * What can be approved. Closed, so every action has a server-built display
 * and a known payload. Add an action here together with its handler.
 *
 *   nexus.install      install an app: artifact digest, scope, permissions (D31)
 *   nexus.update       update an app: same binding as install
 *   os.context.write   write Aura Context (`/api/os/context`, needs-fresh-auth)
 *   user.confirm       an app asks the owner to confirm (D49, `osClient.user.confirm`)
 *   app.adapter-change an app asks a system app's adapter to change files in
 *                      the owner's home (the Terminal's session hooks,
 *                      `/api/terminal/agent-hooks`). Generic (philosophy audit
 *                      #1): the adapter names the files it changes, the shell
 *                      shows them and the owner decides; no product in the kind
 *   credential.store   an app or the CLI asks the owner for a secret (D56,
 *                      `osClient.credentials.request`, `aura secret ask`); the
 *                      owner types it into the shell's dialog, which stores
 *                      it in the owner's vault; the requester gets a handle
 *   credential.read    an app reads a credential's raw value (D56,
 *                      `osClient.credentials.get`): `fresh`, and approving it
 *                      grants `credential.read:<NAME>` until revoked
 *
 * The owner's management routes (D50), asked for from a sandbox (the CLI in
 * the System Terminal) or through Settings; shell `lib/approvals/admin.ts`:
 *   admin.grant        grant a privileged permission (`/api/admin/grants` POST)
 *   admin.revoke       revoke one (`/api/admin/grants` DELETE)
 *   admin.api-key      create or revoke an API key (`/api/admin/api-keys`)
 *   admin.manifest-edit  change an app's tools or permissions (`/api/admin/manifest-edit`)
 *   admin.read         read an owner view: grants, API keys, the audit trail,
 *                      the access report
 *   admin.change       any other owner change: release system modals, reset
 *                      onboarding, reassign an app's origin, overwrite an app
 *                      (`clone-app` / `scaffold` with `force`)
 *
 * App patches (Track P, D9):
 *   app.patch.activate install a prepared app tree from a patch workspace, or
 *                      its rollback tree (`/api/apps/<id>/activate`)
 *   app.source.open    open an installed app's source for direct development
 *                      (`/api/apps/<id>/source-mode`, `aura dev open`)
 *
 * System patches (Phase 7b, D68):
 *   system.patch.activate  build and activate a release with a system patch
 *                      series revision (`/api/admin/system-patches`, `aura
 *                      system patch activate`, `enable`): always `fresh`; the
 *                      payload binds the release, the full PatchBinding
 *                      (base, revision, digest, order, disabled, composition)
 *                      and the touched components (D73)
 */
export const APPROVAL_ACTIONS = [
  'nexus.install', 'nexus.update', 'os.context.write', 'user.confirm', 'app.adapter-change',
  'credential.store', 'credential.read',
  'admin.grant', 'admin.revoke', 'admin.api-key', 'admin.manifest-edit', 'admin.read', 'admin.change',
  'app.patch.activate', 'app.source.open',
  'system.patch.activate',
] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

/**
 * Who asked, kept from a verified principal by `approvalRequester()`. Only
 * stable identity fields: no session id, no unverified actor name.
 */
export type ApprovalRequester =
  /** An app instance or sidecar, acting for `userId` when it has one (5.8). */
  | { kind: 'instance'; appId: string; instanceId: string; sidecar?: string; userId?: string; systemId?: string; lifetime?: string }
  /** A signed-in human, directly or through an app (D45, App Host cookie). */
  | { kind: 'user'; userId: string; systemId?: string; through?: { appId: string; instanceId?: string } }
  /** An external REST caller with an admin-issued key. */
  | { kind: 'apiKey'; keyId: string; name: string };

/**
 * Who decided. Only a signed-in user on the shell itself, or the host
 * operator (`aura approve <id>`, D18). Instance tokens, API keys and a user
 * acting through an app never decide.
 */
export type ApprovalDecider =
  /** `fresh`: the password was verified in the same approve request. */
  | { kind: 'user'; userId: string; sessionId: string; fresh: boolean; systemId?: string }
  | { kind: 'operator' };

/**
 * What the dialog shows, built by the server from verified data (the
 * registry, `PermissionDiff`), never from the requester's wording.
 */
export interface ApprovalDisplay {
  /** One line, e.g. "Install Notes 1.2.0". */
  title: string;
  /** The exact facts being approved: artifact, scope, permissions, … */
  details: string[];
  /** The verified requester as shown, e.g. "Terminal (com.aura.terminal-3)". */
  requestedBy: string;
  /**
   * The requester's own words, if it gave any. The dialog shows them only
   * under a label saying so; they never replace `title` or `details`.
   */
  reason?: string;
  /**
   * What is high risk in it (the install dialog's review, shell
   * lib/approvals/display.ts `installRisks`): one server-built line each,
   * shown first and prominently. Never the requester's wording.
   */
  highRisk?: ApprovalRisk[];
  /**
   * The exact change being approved, as a unified diff (a patch activation,
   * Q23: "exact diff review"). Server-built from the bound content; shown
   * collapsed, in full up to its clip.
   */
  diff?: string;
}

/** One high-risk item of an approval: what, and why it is dangerous, in one line. */
export interface ApprovalRisk {
  item: string;
  why: string;
  /** New with this request (an install, or added by this update). */
  added: boolean;
}

export interface ApprovalRecord {
  /** `newApprovalId()`; matches APPROVAL_ID_RE. */
  id: string;
  requester: ApprovalRequester;
  action: ApprovalAction;
  /** `payloadHash()` of the exact payload this approval allows. */
  payloadHash: string;
  display: ApprovalDisplay;
  level: ApprovalLevel;
  state: ApprovalState;
  /** ms since the epoch. */
  createdAt: number;
  /** `createdAt + APPROVAL_TTL_MS`. Past it, `pending` and `approved` read as `expired`. */
  expiresAt: number;
  /** Set on `approved` and `denied`. */
  decidedBy?: ApprovalDecider;
  /**
   * The payload itself, for the actions whose decision acts on it
   * (`credential.store`: the name and the consuming app). Never a secret;
   * its `payloadHash()` equals `payloadHash`.
   */
  payload?: unknown;
}

/** What a requester supplies. The store adds id, state and times. */
export interface ApprovalRequest {
  requester: ApprovalRequester;
  action: ApprovalAction;
  payloadHash: string;
  display: ApprovalDisplay;
  level: ApprovalLevel;
  /** See `ApprovalRecord.payload`. */
  payload?: unknown;
}

/** What the requester presents when it retries the action. All three must match. */
export interface ApprovalClaim {
  requester: ApprovalRequester;
  action: ApprovalAction;
  payloadHash: string;
}

export type ApprovalRefusal =
  /** The id is unknown (or already removed after expiry). */
  | 'not-found'
  /** The deadline has passed. */
  | 'expired'
  /** The record is not in a state this event applies to. */
  | 'wrong-state'
  /** Consumed by another requester, for another action or another payload. */
  | 'mismatch'
  /** A `fresh` approval decided without a fresh password check. */
  | 'needs-fresh-auth'
  /** Not a principal that may decide (`approvalDecider()` returned null). */
  | 'not-a-decider'
  /** The requester already holds MAX_PENDING_PER_REQUESTER pending requests. */
  | 'too-many-pending'
  /** The requester created too many requests in the last minute. */
  | 'rate-limited'
  /** The owner chose "Deny and block requests from this app". */
  | 'blocked';

export type ApprovalResult =
  | { ok: true; record: ApprovalRecord }
  | { ok: false; reason: ApprovalRefusal };

/**
 * Where approvals live. Stream B implements it as `ValkeyApprovalStore`
 * (`approval:<id>` with a TTL past `expiresAt`). Every write is one atomic
 * step that re-reads the record and applies `transitionApproval()`, so two
 * consumers can never both succeed.
 */
export interface ApprovalStore {
  /** A new pending record, or `too-many-pending`, `rate-limited` or `blocked`. */
  create(request: ApprovalRequest): Promise<ApprovalResult>;
  /** The record with its effective state (`effectiveApprovalState`), or null. */
  get(id: string): Promise<ApprovalRecord | null>;
  /** Pending records, oldest first, for the shell's dialog queue. */
  listPending(): Promise<ApprovalRecord[]>;
  approve(id: string, by: ApprovalDecider): Promise<ApprovalResult>;
  deny(id: string, by: ApprovalDecider): Promise<ApprovalResult>;
  /** Atomic approved → consumed, only for the matching claim. */
  consume(id: string, claim: ApprovalClaim): Promise<ApprovalResult>;
}

// ── principals ──────────────────────────────────────────────────────────────

/** The requester an approval records for `p`, or null when `p` may not request one. */
export function approvalRequester(p: AccessPrincipal): ApprovalRequester | null {
  switch (p.kind) {
    case 'instance':
      return {
        kind: 'instance', appId: p.appId, instanceId: p.instanceId,
        ...(p.sidecar ? { sidecar: p.sidecar } : {}),
        ...(p.userId ? { userId: p.userId } : {}),
        ...(p.systemId ? { systemId: p.systemId } : {}),
        // D85 A9: an approval binds this spawn, so a reused instance id can't consume it.
        ...(p.lifetime ? { lifetime: p.lifetime } : {}),
      };
    case 'user':
      return {
        kind: 'user', userId: p.userId,
        ...(p.systemId ? { systemId: p.systemId } : {}),
        ...(p.through ? { through: { appId: p.through.appId, ...(p.through.instanceId ? { instanceId: p.through.instanceId } : {}) } } : {}),
      };
    case 'apiKey':
      return { kind: 'apiKey', keyId: p.keyId, name: p.name };
    default:
      // anonymous proves nothing; system acts in-process; the operator
      // approves, it does not ask.
      return null;
  }
}

/**
 * The decider `p` may act as, or null. `fresh` is true only when the caller
 * verified the password in this same request.
 */
export function approvalDecider(p: AccessPrincipal, opts: { fresh?: boolean } = {}): ApprovalDecider | null {
  if (p.kind === 'operator') return { kind: 'operator' };
  // Only the shell's own document: never a session that arrived through an app.
  if (p.kind !== 'user' || p.through) return null;
  return {
    kind: 'user', userId: p.userId, sessionId: p.sessionId, fresh: opts.fresh === true,
    ...(p.systemId ? { systemId: p.systemId } : {}),
  };
}

// The channel copy has no imports, so it spells the levels out; keep them equal.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const levelsMatch: Same<ApprovalLevel, AuraApprovalLevel> = true;
void levelsMatch;
