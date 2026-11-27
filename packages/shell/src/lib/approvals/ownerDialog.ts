/**
 * The shell's owner dialog (browser): the behaviour of
 * components/shell/OwnerPasswordDialog.astro, which holds the markup, the
 * styles and what each mode is for. A module so DOM tests can run it.
 *
 * Keyboard (the same in every mode):
 *   - on open, focus goes to the first password field if one is shown,
 *     otherwise to Deny/Cancel; never to Approve;
 *   - Tab and Shift+Tab cycle through the dialog's own controls only;
 *   - ←/→ and ↑/↓ move between the answer buttons;
 *   - Enter activates the focused button; in a field it is the mode's primary
 *     action, which for an approval still waits for APPROVE_DELAY_MS;
 *   - Esc (and the browser's own close request) is Deny or Cancel, never
 *     Approve (D102: for forced and deferrable requests alike).
 *
 * D102: a `deferrable` request also shows Later, which puts it on hold
 * (`POST /api/approvals/<id>/hold`): the dialog closes, the request stays
 * pending and never pops up again by itself, and AuraOS posts one important
 * notification. Its Review calls `window.auraOpenApproval(id)`, which reads
 * the request again from the server and shows it here, with the Approve
 * delay re-armed and the password and secret fields empty. Deny may carry
 * the owner's optional feedback for the requester.
 */
import { approvalBelongsToSender, onAuraChannel, replyTo, type AuraChannelEvent } from '../auraChannelShell.ts';
import {
  APPROVAL_ID_RE, APPROVE_DELAY_MS, approvalReply, decisionErrorText, operatorRequiredText, outcomeOf, parseApprovalView,
  passwordTransportNote, secretTransportNotice,
  type ApprovalDialogView, type ApprovalOutcome, type ApprovalWaiterKind,
} from './dialogClient.ts';
import { renderMarkdown } from '../../components/shell/notifications/MarkdownField.ts';
import { visibleText } from './visibleText.ts';

interface Policy { minLength: number; requiredClasses: number; differFromUsername: boolean }
type Mode = 'password' | 'policy';
interface Waiter { ev: AuraChannelEvent; kind: ApprovalWaiterKind }
interface ClientSession { lock?: string; headers?: () => Record<string, string>; onChange?: (fn: () => void) => unknown }

const RESULT: Record<Mode, string> = {
  password: 'aura.account.password.result',
  policy: 'aura.account.policy.result',
};

/** Arrow keys between the answer buttons: back or forward, no wrap. */
const ARROW_STEP: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };

/** Same ranges as core's parsePasswordPolicy; the server checks again. */
function parsePolicy(x: unknown): Policy | null {
  if (!x || typeof x !== 'object') return null;
  const { minLength, requiredClasses, differFromUsername } = x as Record<string, unknown>;
  const int = (n: unknown, min: number, max: number): n is number => Number.isInteger(n) && (n as number) >= min && (n as number) <= max;
  if (!int(minLength, 4, 128) || !int(requiredClasses, 0, 4) || typeof differFromUsername !== 'boolean') return null;
  return { minLength, requiredClasses, differFromUsername };
}

async function readPolicy(): Promise<Policy | null> {
  const r = await fetch('/api/auth/password-policy', { credentials: 'same-origin' }).catch(() => null);
  const data = (r?.ok ? await r.json().catch(() => null) : null) as { policy?: unknown } | null;
  return parsePolicy(data?.policy);
}

const types = (n: number) => `${n} character type${n === 1 ? '' : 's'}`;
const onOff = (b: boolean) => (b ? 'on' : 'off');

function describeRules(p: Policy): string {
  const parts = [`At least ${p.minLength} characters`];
  if (p.requiredClasses > 0) parts.push(`${types(p.requiredClasses)} of lowercase, uppercase, digits and other`);
  if (p.differFromUsername) parts.push('different from the username');
  return `${parts.join(', ')}.`;
}

/** The exact change, as the shell computes it. */
function diff(from: Policy, to: Policy): string[] {
  const lines: string[] = [];
  if (from.minLength !== to.minLength) lines.push(`Minimum length ${from.minLength} → ${to.minLength}`);
  if (from.requiredClasses !== to.requiredClasses) lines.push(`Character types ${from.requiredClasses} → ${to.requiredClasses}`);
  if (from.differFromUsername !== to.differFromUsername) {
    lines.push(`Must differ from the username ${onOff(from.differFromUsername)} → ${onOff(to.differFromUsername)}`);
  }
  return lines;
}

function errorText(data: { error?: string; rule?: string }, rules: Policy | null): string {
  switch (data.error) {
    case 'invalid-credentials': return 'The current password is wrong.';
    case 'rate-limited': return 'Too many attempts. Wait a minute and try again.';
    case 'login-required': return 'Your login session has ended. Sign in again.';
    case 'conflict': return 'The account changed meanwhile. Try again.';
    case 'invalid-policy': return 'Those rules are out of range.';
    case 'invalid-password':
      if (data.rule === 'length') return `The new password needs at least ${rules?.minLength ?? 'more'} characters.`;
      if (data.rule === 'classes') return `The new password needs ${rules ? types(rules.requiredClasses) : 'more character types'}.`;
      if (data.rule === 'username') return 'The new password must differ from the username.';
      return 'The new password is too long.';
    default: return 'That did not work. Try again.';
  }
}

/** Wire the dialog in this document. Call once. */
export function initOwnerDialog(): void {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const dlg = $<HTMLDialogElement>('aura-owner-password');
  const form = $<HTMLFormElement>('aura-owner-password-form');
  const title = $('aura-owner-password-title');
  const intro = $('aura-owner-password-intro');
  const changes = $<HTMLUListElement>('aura-owner-password-changes');
  const riskBox = $('aura-owner-password-risk');
  const riskList = $<HTMLUListElement>('aura-owner-password-risk-list');
  const reasonBox = $('aura-owner-password-reason');
  const reasonText = $('aura-owner-password-reason-text');
  const explanationBox = $('aura-owner-password-explanation');
  const explanationBody = $('aura-owner-password-explanation-body');
  const currentLabel = $('aura-owner-password-current-label');
  const currentCaption = $('aura-owner-password-current-caption');
  const currentNote = $('aura-owner-password-current-note');
  const current = $<HTMLInputElement>('aura-owner-password-current');
  const newFields = $('aura-owner-password-new-fields');
  const next = $<HTMLInputElement>('aura-owner-password-next');
  const confirm = $<HTMLInputElement>('aura-owner-password-confirm');
  const secretLabel = $('aura-owner-password-secret-label');
  const secretCaption = $('aura-owner-password-secret-caption');
  const secret = $<HTMLInputElement>('aura-owner-password-secret');
  const secretNotice = $('aura-owner-password-secret-notice');
  const hint = $('aura-owner-password-hint');
  const error = $('aura-owner-password-error');
  const cancel = $<HTMLButtonElement>('aura-owner-password-cancel');
  const blockBtn = $<HTMLButtonElement>('aura-owner-password-block');
  const laterBtn = $<HTMLButtonElement>('aura-owner-password-later');
  const feedbackLabel = $('aura-owner-password-feedback-label');
  const feedback = $<HTMLTextAreaElement>('aura-owner-password-feedback');
  const submit = $<HTMLButtonElement>('aura-owner-password-submit');
  if (!dlg || !form || !current || !next || !confirm || !cancel || !submit) return;

  let pending: { ev: AuraChannelEvent; mode: Mode; policy?: Policy } | null = null;
  /** The shell's own read of the rules, for the hint and the error text. */
  let rules: Policy | null = null;

  /** Whether the last close was ours; any other close is the browser's and ends the request as a no. */
  let closedByUs = false;
  function hide(): void {
    if (!dlg?.open) return;
    closedByUs = true;
    dlg.close();
  }

  function clearFields(): void {
    for (const input of [current, next, confirm, secret, feedback]) if (input) input.value = '';
  }

  function finish(result: { ok: true } | { ok: false; error?: string }): void {
    const req = pending;
    pending = null;
    clearFields();
    hide();
    if (req) replyTo(req.ev, { type: RESULT[req.mode], requestId: req.ev.data['requestId'], ...result });
    pump();
  }

  /** The password and policy modes' own layout (the approval mode changes it). */
  function setPasswordMode(): void {
    if (reasonBox) reasonBox.hidden = true;
    if (explanationBox) explanationBox.hidden = true;
    explanationBody?.replaceChildren();
    if (riskBox) riskBox.hidden = true;
    if (blockBtn) blockBtn.hidden = true;
    if (laterBtn) laterBtn.hidden = true;
    if (feedbackLabel) feedbackLabel.hidden = true;
    if (secretLabel) secretLabel.hidden = true;
    if (secretNotice) secretNotice.hidden = true;
    if (currentLabel) currentLabel.hidden = false;
    if (currentCaption) currentCaption.textContent = 'Current password';
    if (currentNote) currentNote.hidden = true;
    if (cancel) cancel.textContent = 'CANCEL';
    if (submit) submit.disabled = false;
  }

  // ── approvals (5.10, D49) ──────────────────────────────────────────────

  /** Open approvals by id, oldest first, with the app windows waiting on each. */
  const queue = new Map<string, { view: ApprovalDialogView; waiters: Waiter[] }>();
  /** The approval in the dialog now. */
  let shown: { id: string; readyAt: number; expiry: ReturnType<typeof setTimeout>; wake: ReturnType<typeof setTimeout> } | null = null;
  let busy = false;
  /** D102: the held request the owner asked to review (Review in its notification); shown next. */
  let reopenId: string | null = null;

  const clientSession = (): ClientSession | undefined => (window as unknown as { __auraClientSession?: ClientSession }).__auraClientSession;
  const locked = () => clientSession()?.lock === 'locked';

  async function readApproval(id: string): Promise<ApprovalDialogView | null> {
    const r = await fetch(`/api/approvals/${encodeURIComponent(id)}`, { credentials: 'same-origin' }).catch(() => null);
    return r?.ok ? parseApprovalView(await r.json().catch(() => null), location.protocol) : null;
  }

  /** Close the dialog on `id` without answering anyone (a hold, a lock). */
  function stepAside(id: string): void {
    if (shown?.id !== id) return;
    clearTimeout(shown.expiry);
    clearTimeout(shown.wake);
    shown = null;
    clearFields();
    hide();
  }

  function settle(id: string, outcome: ApprovalOutcome, words?: string): void {
    const entry = queue.get(id);
    queue.delete(id);
    if (reopenId === id) reopenId = null;
    stepAside(id);
    for (const w of entry?.waiters ?? []) replyTo(w.ev, approvalReply(w.kind, w.ev.data['requestId'], id, outcome, words));
    pump();
  }

  /** An App Host window asks about an approval its app created. */
  async function onAppRequest(ev: AuraChannelEvent, kind: ApprovalWaiterKind): Promise<void> {
    const id = ev.data['approvalId'];
    const refuse = (outcome: ApprovalOutcome) =>
      replyTo(ev, approvalReply(kind, ev.data['requestId'], typeof id === 'string' ? id : '', outcome));
    if (typeof id !== 'string' || !APPROVAL_ID_RE.test(id)) return refuse('unavailable');
    const known = queue.get(id);
    const view = known?.view ?? await readApproval(id);
    // Only the app's own request, and a confirmation only as one.
    if (!view || !approvalBelongsToSender(ev.sender, view.appId) || (kind === 'confirm' && view.action !== 'user.confirm')) {
      return refuse('unavailable');
    }
    const outcome = outcomeOf(view.state);
    if (outcome) return refuse(outcome);
    const entry = queue.get(id) ?? { view, waiters: [] };
    entry.waiters.push({ ev, kind });
    queue.set(id, entry);
    pump();
  }

  /**
   * Show the request the owner asked to review, else the oldest open one
   * that is not on hold, unless another dialog is up or the screen is locked.
   */
  function pump(): void {
    if (shown || pending || busy || !dlg || dlg.open || locked()) return;
    const now = Date.now();
    const asked = reopenId ? queue.get(reopenId) : undefined;
    for (const [id, entry] of asked && reopenId ? [[reopenId, asked] as const, ...queue] : queue) {
      if (entry.view.expiresAt <= now) { settle(id, 'expired'); return; }
      // D102: a held request comes back only through its Review.
      if (entry.view.heldAt !== undefined && id !== reopenId) continue;
      showApproval(entry.view);
      return;
    }
  }

  /** D102 Review: show this request again (a held one too), read fresh from the server. */
  async function openApproval(id: unknown): Promise<'opened' | ApprovalOutcome> {
    if (typeof id !== 'string' || !APPROVAL_ID_RE.test(id)) return 'unavailable';
    const view = await readApproval(id);
    if (!view) { settle(id, 'unavailable'); return 'unavailable'; }
    const outcome = outcomeOf(view.state);
    if (outcome) { settle(id, outcome); return outcome; }
    const entry = queue.get(id);
    if (entry) entry.view = view;
    else queue.set(id, { view, waiters: [] });
    reopenId = id;
    pump();
    return 'opened';
  }

  function showApproval(view: ApprovalDialogView): void {
    if (!dlg || !title || !intro || !changes || !newFields || !error || !submit || !cancel || !reasonBox || !reasonText || !currentLabel) return;
    clearFields();
    error.hidden = true;
    title.textContent = view.display.title;
    intro.textContent = `Requested by ${view.display.requestedBy}`;
    changes.replaceChildren(...view.display.details.map((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      return li;
    }));
    changes.hidden = view.display.details.length === 0;
    // The high-risk review first (5-main item 3): server-built item and why, `NEW` when this request adds it.
    const risks = view.display.highRisk ?? [];
    if (riskList) {
      riskList.replaceChildren(...risks.map((r) => {
        const li = document.createElement('li');
        const item = document.createElement('span');
        item.className = 'aura-owner-password-risk-item';
        item.textContent = r.added ? `NEW: ${r.item}` : r.item;
        const why = document.createElement('span');
        why.className = 'aura-owner-password-risk-why';
        why.textContent = r.why;
        li.append(item, why);
        return li;
      }));
    }
    if (riskBox) riskBox.hidden = risks.length === 0;
    reasonText.textContent = view.display.reason ?? '';
    reasonBox.hidden = !view.display.reason;
    // D109 AF2: the requester's summary as safe Markdown (no HTML node, links and images as text, nothing
    // loaded), cleaned of invisible and bidi characters again here, in its own scroll box below the facts.
    const explanation = view.display.explanation?.text;
    explanationBody?.replaceChildren(...(explanation ? [renderMarkdown(visibleText(explanation), { links: 'text' })] : []));
    if (explanationBody) explanationBody.scrollTop = 0;
    if (explanationBox) explanationBox.hidden = !explanation;
    newFields.hidden = true;
    // D18, D63: the server says how a fresh approval is given here. `operator`: the
    // owner requires HTTPS and this is HTTP, so the password is never sent.
    const hostOnly = view.level === 'fresh' && view.freshVia === 'operator';
    currentLabel.hidden = view.level !== 'fresh' || hostOnly;
    if (hostOnly) {
      error.textContent = operatorRequiredText(view.id);
      error.hidden = false;
    }
    if (currentCaption) currentCaption.textContent = 'Your password (this needs a fresh confirmation)';
    // D63: over HTTP the password is taken, and the dialog says so.
    const note = passwordTransportNote(view, location.protocol);
    if (currentNote) { currentNote.textContent = note ?? ''; currentNote.hidden = !note; }
    // D56: the secret an app asked for, typed only here. Its name comes from the server's title.
    const asksSecret = view.action === 'credential.store';
    if (secretLabel) secretLabel.hidden = !asksSecret;
    if (secretCaption) secretCaption.textContent = 'The secret (sent only to your AuraOS vault, never to the app)';
    // D56: allowed over HTTP, but said plainly; nothing on HTTPS.
    const notice = secretTransportNotice(view.action, location.protocol);
    if (secretNotice) { secretNotice.textContent = notice ?? ''; secretNotice.hidden = !notice; }
    if (blockBtn) blockBtn.hidden = !view.blockable;
    // D102: Later only for a deferrable request; feedback goes with a Deny.
    if (laterBtn) { laterBtn.hidden = view.class !== 'deferrable'; laterBtn.disabled = false; }
    if (feedbackLabel) feedbackLabel.hidden = false;
    cancel.textContent = 'DENY';
    submit.textContent = 'APPROVE';
    // Nothing under a click or an Enter can approve it (5.10).
    submit.disabled = true;
    const readyAt = Date.now() + APPROVE_DELAY_MS;
    shown = {
      id: view.id, readyAt,
      wake: setTimeout(() => { if (shown?.id === view.id && !hostOnly) submit.disabled = false; }, APPROVE_DELAY_MS),
      expiry: setTimeout(() => settle(view.id, 'expired'), Math.max(0, view.expiresAt - Date.now())),
    };
    dlg.showModal();
    (asksSecret && !hostOnly ? secret : view.level === 'fresh' && !hostOnly ? current : cancel)?.focus();
  }

  /** Step aside while the screen locks; come back on unlock. */
  function hideForLock(): void {
    if (shown) stepAside(shown.id);
  }

  /** D102 Later: hold the shown deferrable request. Answers no app: its waiters keep waiting. */
  async function later(): Promise<void> {
    const now = shown;
    if (!now || busy || !error || !laterBtn || laterBtn.hidden) return;
    const entry = queue.get(now.id);
    if (!entry || entry.view.class !== 'deferrable') return;
    busy = true;
    laterBtn.disabled = true;
    const r = await fetch(`/api/approvals/${encodeURIComponent(now.id)}/hold`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(clientSession()?.headers?.() ?? {}) },
      body: '{}',
    }).catch(() => null);
    busy = false;
    laterBtn.disabled = false;
    if (shown?.id !== now.id) return;
    const data = (r ? await r.json().catch(() => ({})) : {}) as { error?: string; heldAt?: unknown; expiresAt?: unknown };
    if (r?.ok) {
      entry.view = {
        ...entry.view,
        heldAt: typeof data.heldAt === 'number' ? data.heldAt : Date.now(),
        ...(typeof data.expiresAt === 'number' ? { expiresAt: data.expiresAt } : {}),
      };
      if (reopenId === now.id) reopenId = null;
      stepAside(now.id);
      pump();
      return;
    }
    if (data.error === 'expired' || data.error === 'wrong-state' || data.error === 'not-found') {
      settle(now.id, outcomeOf((await readApproval(now.id))?.state) ?? 'unavailable');
      return;
    }
    error.textContent = r ? decisionErrorText(data.error, now.id) : 'Could not reach AuraOS.';
    error.hidden = false;
  }

  async function decide(decision: 'approve' | 'deny', block = false): Promise<void> {
    const now = shown;
    if (!now || busy || !error || !submit) return;
    if (decision === 'approve' && (submit.disabled || Date.now() < now.readyAt)) return;
    const view = queue.get(now.id)?.view;
    if (!view) return;
    const body: Record<string, unknown> = {};
    if (decision === 'approve' && view.level === 'fresh') {
      if (!current?.value) { error.textContent = 'Enter your password to approve this.'; error.hidden = false; current?.focus(); return; }
      body['password'] = current.value;
    }
    if (decision === 'approve' && view.action === 'credential.store') {
      if (!secret?.value) { error.textContent = 'Enter the secret to approve this.'; error.hidden = false; secret?.focus(); return; }
      body['secret'] = secret.value;
    }
    if (block) body['block'] = true;
    const words = decision === 'deny' ? feedback?.value.trim() || undefined : undefined;
    if (words) body['feedback'] = words;
    busy = true;
    submit.disabled = true;
    const r = await fetch(`/api/approvals/${encodeURIComponent(now.id)}/${decision}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(clientSession()?.headers?.() ?? {}) },
      body: JSON.stringify(body),
    }).catch(() => null);
    delete body['password'];
    delete body['secret'];
    if (current) current.value = '';
    busy = false;
    if (shown?.id !== now.id) return;
    if (r?.ok) { settle(now.id, decision === 'approve' ? 'approved' : 'denied', words); return; }
    const data = (r ? await r.json().catch(() => ({})) : {}) as { error?: string };
    if (data.error === 'expired' || data.error === 'wrong-state' || data.error === 'not-found') {
      settle(now.id, outcomeOf((await readApproval(now.id))?.state) ?? 'unavailable');
      return;
    }
    submit.disabled = false;
    error.textContent = r ? decisionErrorText(data.error, now.id) : 'Could not reach AuraOS.';
    error.hidden = false;
    if (dlg && !dlg.open) dlg.showModal();
    (view.level === 'fresh' && data.error === 'invalid-credentials' ? current : cancel)?.focus();
  }

  /** The server's pending list: requests from Terminal agents and the CLI, and decisions made in other tabs. */
  async function pollApprovals(): Promise<void> {
    let seen: number | null = null;
    for (;;) {
      const r = await fetch(`/api/approvals${seen === null ? '' : `?seen=${seen}`}`, { credentials: 'same-origin' }).catch(() => null);
      if (!r || !r.ok) {
        await new Promise((res) => setTimeout(res, r?.status === 401 ? 60_000 : 5_000));
        seen = null;
        continue;
      }
      const data = await r.json().catch(() => null) as { version?: unknown; pending?: unknown[] } | null;
      seen = typeof data?.version === 'number' ? data.version : null;
      const open = new Set<string>();
      for (const raw of data?.pending ?? []) {
        const view = parseApprovalView(raw, location.protocol);
        if (!view || view.state !== 'pending') continue;
        open.add(view.id);
        const entry = queue.get(view.id);
        if (!entry) { queue.set(view.id, { view, waiters: [] }); continue; }
        entry.view = view;
        // D102: put on hold in another tab: step aside here too (its waiters keep waiting).
        if (view.heldAt !== undefined && shown?.id === view.id && reopenId !== view.id && !busy) stepAside(view.id);
      }
      // Decided elsewhere (another tab, `aura approve`) or gone: settle what waits here.
      for (const id of [...queue.keys()]) {
        if (open.has(id) || (shown?.id === id && busy)) continue;
        const state = (await readApproval(id))?.state;
        const outcome = outcomeOf(state);
        if (outcome) settle(id, outcome);
      }
      pump();
    }
  }

  function showError(text: string): void {
    if (!error) return;
    error.textContent = text;
    error.hidden = false;
  }

  async function open(ev: AuraChannelEvent, mode: Mode): Promise<void> {
    const refuse = (err: string) => replyTo(ev, { type: RESULT[mode], requestId: ev.data['requestId'], ok: false, error: err });
    if (pending || shown || !dlg || !title || !intro || !changes || !newFields || !hint || !error || !submit) return refuse('busy');

    let requested: Policy | undefined;
    if (mode === 'policy') {
      const parsed = parsePolicy(ev.data['policy']);
      if (!parsed) return refuse('invalid-policy');
      requested = parsed;
    }
    pending = { ev, mode, ...(requested ? { policy: requested } : {}) };
    rules = await readPolicy();
    if (pending?.ev !== ev) return;
    if (!rules) {
      pending = null;
      return refuse('unavailable');
    }

    clearFields();
    error.hidden = true;
    changes.replaceChildren();
    setPasswordMode();
    if (mode === 'policy' && requested) {
      const lines = diff(rules, requested);
      if (lines.length === 0) {
        pending = null;
        return refuse('unchanged');
      }
      title.textContent = 'CONFIRM PASSWORD RULES';
      intro.textContent = 'Settings asks to change the rules for new passwords. Existing passwords stay valid. Enter your password to confirm:';
      for (const line of lines) {
        const li = document.createElement('li');
        li.textContent = line;
        changes.append(li);
      }
      changes.hidden = false;
      newFields.hidden = true;
      submit.textContent = 'CONFIRM';
    } else {
      title.textContent = 'CHANGE PASSWORD';
      intro.textContent = 'AuraOS is asking on behalf of Settings. Your other sessions are signed out; this one stays.';
      changes.hidden = true;
      newFields.hidden = false;
      hint.textContent = describeRules(rules);
      submit.textContent = 'CHANGE';
    }
    dlg.showModal();
    current?.focus();
  }

  /** The mode's primary action: Approve (only once it is enabled), or the password and policy change. */
  async function primary(): Promise<void> {
    if (shown) { void decide('approve'); return; }
    const req = pending;
    if (!req || !current || !next || !confirm || !submit || submit.disabled) return;
    if (!current.value) { showError('Enter your current password.'); current.focus(); return; }
    let url: string;
    let method: string;
    let body: Record<string, unknown>;
    if (req.mode === 'password') {
      if (next.value !== confirm.value) { showError('The new passwords do not match.'); next.focus(); return; }
      [url, method, body] = ['/api/auth/password', 'POST', { current: current.value, next: next.value }];
    } else {
      [url, method, body] = ['/api/auth/password-policy', 'PUT', { current: current.value, policy: req.policy }];
    }
    submit.disabled = true;
    const r = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    body = {};
    submit.disabled = false;
    if (pending !== req) return;
    if (r?.ok) { finish({ ok: true }); return; }
    const data = (r ? await r.json().catch(() => ({})) : {}) as { error?: string; rule?: string };
    current.value = '';
    showError(r ? errorText(data, rules) : 'Could not reach AuraOS.');
    (data.error === 'invalid-password' ? next : current).focus();
  }

  // ── keyboard ───────────────────────────────────────────────────────────

  const usable = (el: HTMLInputElement | HTMLButtonElement) => !el.disabled && !el.closest('[hidden]');
  /** What Tab cycles through: the shown, enabled fields and buttons, in order. */
  const controls = () => [...dlg.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, textarea, button')].filter(usable);
  /** What the arrows move between. */
  const answers = () => [blockBtn, cancel, laterBtn, submit].filter((b): b is HTMLButtonElement => !!b && usable(b));

  /** Esc or a close request: Deny an approval, cancel a password dialog. Never Approve. */
  function dismiss(): void {
    if (shown) void decide('deny');
    else if (pending) finish({ ok: false, error: 'cancelled' });
  }

  function onKey(e: KeyboardEvent): void {
    if (!dlg?.open || e.isComposing) return;
    const at = document.activeElement as HTMLElement | null;
    const inside = !!at && dlg.contains(at);
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'Escape') { handled(); dismiss(); return; }
    if (e.key === 'Tab') {
      handled();
      const list = controls();
      if (!list.length) return;
      const i = inside ? list.indexOf(at as HTMLButtonElement) : -1;
      const step = e.shiftKey ? -1 : 1;
      list[i < 0 ? (step > 0 ? 0 : list.length - 1) : (i + step + list.length) % list.length]!.focus();
      return;
    }
    const step = ARROW_STEP[e.key];
    if (step && at?.tagName === 'BUTTON') {
      const list = answers();
      const i = list.indexOf(at as HTMLButtonElement);
      if (i < 0) return;
      handled();
      list[Math.min(list.length - 1, Math.max(0, i + step))]!.focus();
      return;
    }
    // The feedback box takes Enter as a new line.
    if (e.key === 'Enter' && at && inside && at.tagName !== 'TEXTAREA' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      handled();
      // A held Enter from before the dialog opened answers nothing.
      if (e.repeat) return;
      if (at.tagName === 'BUTTON') { if (!(at as HTMLButtonElement).disabled) at.click(); }
      else if (at.tagName === 'INPUT') void primary();
    }
  }

  onAuraChannel('aura.account.password.request', (ev) => { void open(ev, 'password'); });
  onAuraChannel('aura.account.policy.request', (ev) => { void open(ev, 'policy'); });
  onAuraChannel('aura.approval.request', (ev) => { void onAppRequest(ev, 'approval'); });
  onAuraChannel('aura.user.confirm.request', (ev) => { void onAppRequest(ev, 'confirm'); });
  cancel.addEventListener('click', dismiss);
  blockBtn?.addEventListener('click', () => { void decide('deny', true); });
  laterBtn?.addEventListener('click', () => { void later(); });
  // D102: a hold notification's Review (lib/notifications/context.ts `goToContext`).
  (window as unknown as { auraOpenApproval?: (id: unknown) => Promise<string> }).auraOpenApproval = openApproval;
  // Before the shell's own shortcuts; the open modal makes everything else inert.
  window.addEventListener('keydown', onKey, { capture: true });
  // The browser's close request (Android back, a CloseWatcher) is Esc too. If it
  // closes the dialog without asking, the open request still ends as a no.
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); dismiss(); });
  dlg.addEventListener('close', () => {
    if (closedByUs) { closedByUs = false; return; }
    if (!dlg.open) dismiss();
  });
  clientSession()?.onChange?.(() => { if (locked()) hideForLock(); else pump(); });
  window.addEventListener('focus', () => pump());
  void pollApprovals();
  form.addEventListener('submit', (e) => { e.preventDefault(); void primary(); });
}
