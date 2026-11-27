/**
 * Owner approvals from the CLI (5.10, D18, D31, D50). In an app sandbox the
 * CLI asks with its instance token and waits while the owner decides in the
 * desktop: installs (commands/nexus.ts) and every owner-management call
 * (grants, API keys, the audit trail, manifest edits; lib/client.ts). On the
 * host the operator is the owner's stand-in: its one-time ticket lets it act
 * directly, and an operator code (a ticket file only the host can write)
 * vouches for one exact install.
 *
 * D102: the owner may put a deferrable request on hold ("Later" in the
 * desktop). It stays pending and authorizes nothing for up to 24 hours.
 *   - interactive (a TTY): the CLI says so once and keeps waiting until the
 *     request is approved, denied, expired or cancelled (Ctrl-C withdraws it);
 *   - non-interactive (an agent): it prints a structured `on_hold` result
 *     (request id, deadline, how to resume) and exits with code 75
 *     (EX_TEMPFAIL); `AURA_WAIT_ON_HOLD=1` waits instead.
 * Running the same command again resumes the original request (the server
 * answers with it): no duplicate request, no second notification. Every
 * outcome other than approved is printed as one JSON line on stdout when
 * stdout is not a terminal (`{"approval": {"outcome": …}}`), with the
 * owner's denial feedback when they gave any.
 */
import { issueSetupCode } from './setup-ticket.js';
import { shellFetch } from './identity.js';

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'consumed' | 'expired' | 'cancelled';

export interface ApprovalView {
  id: string;
  action: string;
  level: 'session' | 'fresh';
  state: ApprovalState;
  expiresAt: number;
  display: {
    title: string; details: string[]; requestedBy: string; reason?: string;
    /** The server's high-risk review (shell lib/approvals/display.ts), printed first. */
    highRisk?: Array<{ item: string; why: string; added?: boolean }>;
  };
  /** D102: `deferrable` requests may be put on hold by the owner. */
  class?: 'forced' | 'deferrable';
  /** D102: set while the owner has put it on hold (still pending). */
  heldAt?: number;
  /** D102: the owner's words with a denial. */
  feedback?: string;
  /** D102: `requester` (withdrawn) or `system` (no longer valid). */
  cancelledBy?: 'requester' | 'system';
}

export const APPROVAL_HEADER = 'X-Aura-Approval';
export const POLL_MS = 2_000;
/** D102: a non-interactive caller whose request is on hold exits with this (EX_TEMPFAIL). */
export const EXIT_ON_HOLD = 75;

/** How a wait ended. `on_hold`: the owner put it on hold and this caller does not wait for it. */
export type ApprovalOutcome = 'approved' | 'denied' | 'expired' | 'cancelled' | 'on_hold' | 'unknown';

export interface WaitResult {
  outcome: ApprovalOutcome;
  /** The last view read, when there was one. */
  view?: Partial<ApprovalView>;
}

/** Whether this process waits for a held request: on a terminal, or when asked to (D102). */
export function waitsOnHold(): boolean {
  if (process.env['AURA_WAIT_ON_HOLD'] === '1') return true;
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

function outcomeOfState(state: string | undefined): ApprovalOutcome | null {
  switch (state) {
    case 'pending': return null;
    case 'approved': case 'consumed': return 'approved';
    case 'denied': return 'denied';
    case 'expired': return 'expired';
    case 'cancelled': return 'cancelled';
    default: return 'unknown';
  }
}

const heldUntil = (v: Partial<ApprovalView>): string =>
  typeof v.expiresAt === 'number' ? new Date(v.expiresAt).toISOString() : 'up to 24 hours';

/** The structured result for a caller that reads it (an agent): one JSON line on stdout, not on a terminal. */
export function printApprovalResult(id: string, r: WaitResult): void {
  if (process.stdout.isTTY) return;
  const v = r.view ?? {};
  const out: Record<string, unknown> = { outcome: r.outcome, approvalId: id };
  if (v.action) out['action'] = v.action;
  if (v.display?.title) out['title'] = v.display.title;
  if (r.outcome === 'on_hold') {
    out['heldUntil'] = heldUntil(v);
    out['resume'] = 'Run the same command again (in this same app instance) to continue: it resumes this request, it does not ask again.';
  }
  if (r.outcome === 'denied' && v.feedback) out['feedback'] = v.feedback;
  if (r.outcome === 'cancelled' && v.cancelledBy) out['cancelledBy'] = v.cancelledBy;
  process.stdout.write(`${JSON.stringify({ approval: out })}\n`);
}

/** The human line for an outcome other than approved. */
export function outcomeText(r: WaitResult): string {
  const v = r.view ?? {};
  switch (r.outcome) {
    case 'denied': return v.feedback ? `denied by the owner: ${v.feedback}` : 'denied by the owner';
    case 'expired': return 'the request expired';
    case 'cancelled': return v.cancelledBy === 'system' ? 'the request is no longer valid and was cancelled' : 'the request was withdrawn';
    case 'on_hold': return `on hold in the AuraOS desktop until ${heldUntil(v)}`;
    default: return 'the request is unknown';
  }
}

/**
 * D102: the request is on hold and this caller does not wait: say how to
 * resume, print the structured result, exit 75.
 */
export function exitOnHold(id: string, view: Partial<ApprovalView>, print: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): never {
  print(`On hold in the AuraOS desktop until ${heldUntil(view)} (request ${id}). Run the same command again later to continue; it resumes this request.`);
  printApprovalResult(id, { outcome: 'on_hold', view });
  process.exit(EXIT_ON_HOLD);
}

/** D102: withdraw this process's own open request (Ctrl-C). Best effort. */
export async function withdrawApproval(id: string): Promise<boolean> {
  try {
    const res = await shellFetch(`/api/approvals/${encodeURIComponent(id)}/cancel`, {
      method: 'POST', intent: 'self', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** POST JSON and read the JSON answer whatever the status (202 needs-approval, 4xx errors). */
export async function postJson<T>(path: string, body: unknown, opts: { approvalId?: string } = {}): Promise<T> {
  const res = await shellFetch(path, {
    method: 'POST',
    intent: 'self',
    headers: { 'Content-Type': 'application/json', ...(opts.approvalId ? { [APPROVAL_HEADER]: opts.approvalId } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return { error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}` } as T;
  }
}

/**
 * Poll an approval this process asked for until the owner decides, it
 * expires or is cancelled. D102: a held request returns `on_hold` unless
 * `waitOnHold` (default: `waitsOnHold()`); waiting, `onHold` is told once.
 * Ctrl-C while waiting withdraws the request (`withdraw: false` keeps it).
 */
export async function waitForApproval(
  id: string,
  opts: {
    pollMs?: number; sleep?: (ms: number) => Promise<void>;
    waitOnHold?: boolean; onHold?: (view: Partial<ApprovalView>) => void; withdraw?: boolean;
  } = {},
): Promise<WaitResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitOnHold = opts.waitOnHold ?? waitsOnHold();
  let told = false;
  const onSigint = () => {
    void withdrawApproval(id).finally(() => {
      process.stderr.write(`\nWithdrew request ${id}.\n`);
      printApprovalResult(id, { outcome: 'cancelled', view: { cancelledBy: 'requester' } });
      process.exit(130);
    });
  };
  if (opts.withdraw !== false) process.once('SIGINT', onSigint);
  try {
    for (;;) {
      const res = await shellFetch(`/api/approvals/${encodeURIComponent(id)}`, { intent: 'self' });
      if (res.status === 404) return { outcome: 'unknown' };
      const view = await res.json().catch(() => null) as Partial<ApprovalView> | null;
      const outcome = outcomeOfState(view?.state);
      if (outcome) return { outcome, ...(view ? { view } : {}) };
      if (!res.ok && res.status !== 202) return { outcome: 'unknown' };
      if (view && typeof view.heldAt === 'number') {
        if (!waitOnHold) return { outcome: 'on_hold', view };
        if (!told) { told = true; opts.onHold?.(view); }
      }
      await sleep(opts.pollMs ?? POLL_MS);
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

/** A one-time operator code for `subject`. Refused inside an app sandbox (SetupCodeRefused). */
export async function operatorCode(subject: string): Promise<string> {
  return (await issueSetupCode({ purpose: 'operator', subject })).code;
}

/** The lines the CLI prints for an approval: what the server built, the requester's words labelled. */
export function approvalLines(v: Pick<ApprovalView, 'display' | 'level'>): string[] {
  const risks = v.display.highRisk ?? [];
  return [
    v.display.title,
    ...(risks.length ? ['  HIGH RISK:', ...risks.flatMap((r) => [`    ${r.added ? 'NEW: ' : ''}${r.item}`, `      ${r.why}`])] : []),
    ...v.display.details.map((d) => `  ${d}`),
    `  Requested by: ${v.display.requestedBy}`,
    ...(v.display.reason ? [`  In the requester's own words (not verified): ${v.display.reason}`] : []),
    ...(v.level === 'fresh' ? ['  Level: fresh (password or host operator)'] : []),
  ];
}

/** A route's 202 needs-approval answer (shell lib/approvals). */
export interface NeedsApproval {
  needsApproval: true;
  approvalId?: string;
  level?: 'session' | 'fresh';
  display?: ApprovalView['display'];
  /** D102: the request's state, class and hold (a resumed request may already be held or approved). */
  state?: ApprovalState;
  class?: 'forced' | 'deferrable';
  heldAt?: number;
  expiresAt?: number;
  /** D102: the server answered with this requester's earlier request for the same thing. */
  resumed?: boolean;
  /** No requester identity: only the host operator can confirm it. */
  operatorOnly?: boolean;
  /** Why an approval this request presented was not taken (`mismatch`, `expired`, …). */
  refused?: string;
}

/** The needs-approval answer in a response body, if it is one. */
export function needsApprovalOf(status: number, text: string): NeedsApproval | null {
  if (status !== 202) return null;
  try {
    const body = JSON.parse(text) as Partial<NeedsApproval> | null;
    return body?.needsApproval === true ? body as NeedsApproval : null;
  } catch {
    return null;
  }
}

/**
 * Show what the server asks the owner, then wait for the decision in the
 * desktop (or `aura approve <id>` on the host). The approval id once
 * approved; null when it was denied, expired or cannot be asked for here.
 */
export async function askOwner(
  asked: NeedsApproval,
  opts: { print?: (line: string) => void; wait?: typeof waitForApproval } = {},
): Promise<{ approvalId: string } | { refused: string; outcome?: ApprovalOutcome; feedback?: string }> {
  const print = opts.print ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (!asked.approvalId) {
    return { refused: asked.operatorOnly ? 'only the host operator can confirm this: run the command on the host' : 'no approval was offered' };
  }
  const id = asked.approvalId;
  if (asked.display) for (const line of approvalLines({ display: asked.display, level: asked.level ?? 'session' })) print(line);
  if (asked.resumed) print(`Continuing your earlier request ${id}.`);
  // D102: held already (a resumed request): an agent gets the structured answer at once.
  if (typeof asked.heldAt === 'number' && asked.state !== 'approved' && !waitsOnHold()) {
    exitOnHold(id, { expiresAt: asked.expiresAt, ...(asked.display ? { display: asked.display } : {}) }, print);
  }
  if (asked.state !== 'approved') {
    print(`Approve in the AuraOS desktop${asked.level === 'fresh' ? ' (with your password)' : ''}, or on the host: docker exec -it aura-shell aura approve ${id}. Waiting… (Ctrl-C withdraws the request)`);
  }
  const r = await (opts.wait ?? waitForApproval)(id, {
    onHold: (v) => print(`On hold in the AuraOS desktop until ${heldUntil(v)}. Still waiting; Ctrl-C withdraws it.`),
  });
  if (r.outcome === 'approved') return { approvalId: id };
  if (r.outcome === 'on_hold') exitOnHold(id, r.view ?? {}, print);
  printApprovalResult(id, r);
  return { refused: `not approved: ${outcomeText(r)}`, outcome: r.outcome, ...(r.view?.feedback ? { feedback: r.view.feedback } : {}) };
}
