/**
 * Owner approvals from the CLI (5.10, D18, D31). In an app sandbox the CLI
 * asks with its instance token and waits while the owner decides in the
 * desktop. On the host the operator is the owner's stand-in: an operator code
 * (a one-time ticket file only the host can write) vouches for one exact
 * request.
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
  display: { title: string; details: string[]; requestedBy: string; reason?: string };
}

export const APPROVAL_HEADER = 'X-Aura-Approval';
export const POLL_MS = 2_000;

/** POST JSON and read the JSON answer whatever the status (202 needs-approval, 4xx errors). */
export async function postJson<T>(path: string, body: unknown, opts: { approvalId?: string; intent?: 'self' | 'admin' } = {}): Promise<T> {
  const res = await shellFetch(path, {
    method: 'POST',
    intent: opts.intent ?? 'self',
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
  return [
    v.display.title,
    ...v.display.details.map((d) => `  ${d}`),
    `  Requested by: ${v.display.requestedBy}`,
    ...(v.display.reason ? [`  In the requester's own words (not verified): ${v.display.reason}`] : []),
    ...(v.level === 'fresh' ? ['  Level: fresh (password or host operator)'] : []),
  ];
}
