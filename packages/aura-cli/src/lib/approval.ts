/**
 * Owner approvals from the CLI (5.10, D18, D31, D50). In an app sandbox the
 * CLI asks with its instance token and waits while the owner decides in the
 * desktop: installs (commands/nexus.ts) and every owner-management call
 * (grants, API keys, the audit trail, manifest edits; lib/client.ts). On the
 * host the operator is the owner's stand-in: its one-time ticket lets it act
 * directly, and an operator code (a ticket file only the host can write)
 * vouches for one exact install.
 */
import { issueSetupCode } from './setup-ticket.js';
import { shellFetch } from './identity.js';

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';

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
}

export const APPROVAL_HEADER = 'X-Aura-Approval';
export const POLL_MS = 2_000;

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

/** Poll an approval this process asked for until the owner decides or it expires. */
export async function waitForApproval(
  id: string,
  opts: { pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ApprovalState | 'unknown'> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const res = await shellFetch(`/api/approvals/${encodeURIComponent(id)}`, { intent: 'self' });
    if (res.status === 404) return 'unknown';
    const view = await res.json().catch(() => null) as Partial<ApprovalView> | null;
    const state = view?.state;
    if (state && state !== 'pending') return state;
    if (!res.ok && res.status !== 202) return 'unknown';
    await sleep(opts.pollMs ?? POLL_MS);
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
): Promise<{ approvalId: string } | { refused: string }> {
  const print = opts.print ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (!asked.approvalId) {
    return { refused: asked.operatorOnly ? 'only the host operator can confirm this: run the command on the host' : 'no approval was offered' };
  }
  if (asked.display) for (const line of approvalLines({ display: asked.display, level: asked.level ?? 'session' })) print(line);
  print(`Approve in the AuraOS desktop${asked.level === 'fresh' ? ' (with your password)' : ''}, or on the host: docker exec -it aura-shell aura approve ${asked.approvalId}. Waiting…`);
  const state = await (opts.wait ?? waitForApproval)(asked.approvalId);
  return state === 'approved' ? { approvalId: asked.approvalId } : { refused: `not approved: ${state}` };
}
