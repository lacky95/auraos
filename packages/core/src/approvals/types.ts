/**
 * The approval record (5.10, D16, D17, D31, D49): a sensitive action a
 * verified requester asks for, which the owner decides in the shell's own
 * dialog and the server consumes exactly once.
 *
 *   requester ──create──▶ pending ──approve──▶ approved ──consume──▶ consumed
 *                          │  ▲ │                   │
 *            (owner) hold ─┘  │ ├──deny──▶ denied   ├──(expiresAt)──▶ expired
 *         (still pending,     │ │                   └──cancel──▶ cancelled
 *          `heldAt` set)  ────┘ ├──(expiresAt)──▶ expired
 *                               └──cancel──▶ cancelled (the requester withdrew,
 *                                            or revalidation found it stale)
 *
 * `denied`, `consumed`, `expired` and `cancelled` are final. Transitions are checked by the
 * pure `transitionApproval()` (state.ts); the store (`ApprovalStore`) applies
 * them atomically. The record binds the requester, the action and the payload
 * hash: consuming it with any other one is refused.
 *
 * Nothing here holds a credential: no token, cookie, password or proof.
 */
import type { AccessPrincipal } from '../auth/types.js';
import type { AuraApprovalLevel } from '../app-hosts/auraChannel.js';

/**
 * How long an open request waits for the owner, and how long an approval can
 * be used once given: the 10-minute use window starts at the explicit approve
 * (D102), not at the request.
 */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;
/**
 * A deferrable request the owner put on hold ("Later", D102) stays pending,
 * and authorizes nothing, for at most this long from its creation.
 */
export const HOLD_TTL_MS = 24 * 60 * 60 * 1000;
/** Longest denial feedback the owner can send back to the requester (D102). */
export const MAX_DENIAL_FEEDBACK = 500;
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

export const APPROVAL_STATES = ['pending', 'approved', 'denied', 'consumed', 'expired', 'cancelled'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];
export const FINAL_APPROVAL_STATES: ReadonlySet<ApprovalState> = new Set(['denied', 'consumed', 'expired', 'cancelled']);

/**
 * D102: how a request may be answered. Both classes first open the full
 * blocking owner dialog.
 *   forced      decide now: Approve or Deny (Esc). Never a notification.
 *   deferrable  the dialog also offers Later: the request is held (still
 *               pending, authorizes nothing) and AuraOS posts one important
 *               notification whose Review reopens the same dialog.
 * The class comes from this catalog (`approvalClassOf`), never from the
 * requester, and is fixed on the record when it is created.
 */
export const APPROVAL_CLASSES = ['forced', 'deferrable'] as const;
export type ApprovalClass = (typeof APPROVAL_CLASSES)[number];

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
 */
export const APPROVAL_ACTIONS = [
  'nexus.install', 'nexus.update', 'os.context.write', 'user.confirm', 'app.adapter-change',
  'credential.store', 'credential.read',
  'admin.grant', 'admin.revoke', 'admin.api-key', 'admin.manifest-edit', 'admin.read', 'admin.change',
  'app.patch.activate', 'app.source.open',
] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

/**
 * D102 default class per action. Forced: anything that installs, activates or
 * replaces code, runs as root, changes the system mode or the security
 * posture, or only makes sense now. Deferrable: what an agent or the CLI asks
 * for where waiting harms nothing. `admin.change` is per operation
 * (`DEFERRABLE_ADMIN_CHANGES`); an operation not listed there is forced.
 */
export const APPROVAL_CLASS: Readonly<Record<ApprovalAction, ApprovalClass>> = {
  'nexus.install': 'forced',
  'nexus.update': 'forced',
  'app.patch.activate': 'forced',
  'user.confirm': 'forced',
  'admin.change': 'forced',
  'os.context.write': 'deferrable',
  'app.adapter-change': 'deferrable',
  'credential.store': 'deferrable',
  'credential.read': 'deferrable',
  'admin.grant': 'deferrable',
  'admin.revoke': 'deferrable',
  'admin.api-key': 'deferrable',
  'admin.manifest-edit': 'deferrable',
  'admin.read': 'deferrable',
  'app.source.open': 'deferrable',
};

/**
 * The `admin.change` operations (`payload.op`) that may wait. Everything else
 * under `admin.change` stays forced: root and privileged runs (cap and base
 * package installs, the PRoot upgrade), Developer Mode, security options,
 * restarts and self-update, releasing system modals, overwriting an app's
 * code (clone, scaffold).
 */
export const DEFERRABLE_ADMIN_CHANGES: ReadonlySet<string> = new Set([
  'system-mode.export-patches', 'shell-mode', 'onboarding.reset', 'app-origin.reassign',
  'mount.workspace', 'dev.system-decision',
]);

/** The class of one request: the action's, and for `admin.change` its operation's. */
export function approvalClassOf(action: ApprovalAction, payload: unknown): ApprovalClass {
  const base = APPROVAL_CLASS[action] ?? 'forced';
  if (action !== 'admin.change') return base;
  const op = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)['op'] : undefined;
  return typeof op === 'string' && DEFERRABLE_ADMIN_CHANGES.has(op) ? 'deferrable' : 'forced';
}

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
  /**
   * Past it, `pending` and `approved` read as `expired`. `createdAt +
   * APPROVAL_TTL_MS` when created, `createdAt + HOLD_TTL_MS` once held,
   * `approvedAt + APPROVAL_TTL_MS` once approved.
   */
  expiresAt: number;
  /** D102: fixed at creation from the catalog (`approvalClassOf`). Records without it are forced. */
  class?: ApprovalClass;
  /** D102: when the owner chose Later. The record stays `pending`. */
  heldAt?: number;
  /** Who held it. */
  heldBy?: ApprovalDecider;
  /** D102: the id of the one notification that points at a held request. Never a credential. */
  notice?: string;
  /** Set on `approved` and `denied`. */
  decidedBy?: ApprovalDecider;
  /** When it was approved: the 10-minute use window starts here. */
  approvedAt?: number;
  /**
   * D102: the owner's optional words with a denial, for the requester to
   * adapt its plan. Plain text, at most MAX_DENIAL_FEEDBACK characters. It
   * grants nothing.
   */
  feedback?: string;
  /** Set on `cancelled`: the requester withdrew it, or the system found it stale (`system:<reason>`). */
  cancelledBy?: 'requester' | `system:${string}`;
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
  /** D102: from `approvalClassOf()`; absent means forced. */
  class?: ApprovalClass;
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
  | 'blocked'
  /** D102: Later on a forced request. */
  | 'not-deferrable'
  /**
   * D102: revalidation found the request no longer valid (the requesting app
   * or instance is gone, the app was blocked, the consuming app was removed).
   * The record is cancelled.
   */
  | 'stale';

export type ApprovalResult =
  /** `resumed` (create only): the requester's own open request for the same thing (D102). */
  | { ok: true; record: ApprovalRecord; resumed?: boolean }
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
  /** Pending records (held ones too, with `heldAt`), oldest first, for the shell's dialog queue. */
  listPending(): Promise<ApprovalRecord[]>;
  approve(id: string, by: ApprovalDecider): Promise<ApprovalResult>;
  /** `feedback`: the owner's optional words for the requester (D102). */
  deny(id: string, by: ApprovalDecider, feedback?: string): Promise<ApprovalResult>;
  /** D102: Later. A deferrable pending request stays pending until `createdAt + HOLD_TTL_MS`. */
  hold(id: string, by: ApprovalDecider): Promise<ApprovalResult>;
  /** D102: the requester withdraws its open request, or the system cancels a stale one. */
  cancel(id: string, by: ApprovalCanceller): Promise<ApprovalResult>;
  /** Record (or clear) the hold notification's id on an open record. */
  setNotice(id: string, notice: string | null): Promise<ApprovalResult>;
  /** Atomic approved → consumed, only for the matching claim. */
  consume(id: string, claim: ApprovalClaim): Promise<ApprovalResult>;
}

/** Who cancels: the requester itself (checked like a claim), or the system after a failed revalidation. */
export type ApprovalCanceller =
  | { kind: 'requester'; requester: ApprovalRequester }
  | { kind: 'system'; reason: string };

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
