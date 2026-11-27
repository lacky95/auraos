/**
 * The setup window (D108 W1): an app that may not start yet because its
 * setup is needed opens a window in setup state instead of being refused.
 * The window is the launch's own Activity window; the shell draws the setup
 * wizard in it (shell DOM, the owner's session, like the frame notices in
 * lib/appFrame.ts). The app's frame is never loaded before the setup reports
 * `ready`; then the launch continues in the same window and the frame
 * resolves as for every app (`resolveAppFrame`, unchanged).
 *
 *   launch     `startWithSetup`: the desktop's `POST /api/apps/<id>/start`.
 *              An app without setup: exactly that one call, its answer
 *              unchanged. A 409 whose D105 body is a setup refusal
 *              (`needs-setup`, or A1's `setup-unsupported`) shows the
 *              window in setup state and starts again once it is ready.
 *   wizard     `mountSetupWindow`: the engine's steps (`SetupPlan.steps`,
 *              skipped ones not walked), resumed at the recorded step
 *              (`SetupStateView.step`), through `/api/apps/<id>/setup/**`
 *              (lib/setup/api.ts). Profile → values → requirements →
 *              review → apply; 202 on-hold shows the pending approval,
 *              which the owner decides in the shell's approval dialog
 *              (D102) — never here; initializing shows the engine's state.
 *
 * Presentation only: every state comes from the API, nothing is decided
 * here and nothing is invented (503 `unavailable` without an engine is a
 * notice, never progress). Secrets are vault handles only (D56).
 */
import type { SetupOutcome, SetupPlan, SetupProposal, SetupStateView, SetupStep } from '@aura/core';
import type { SchemaForm } from '@aura/ui/setup';
import { resolveAppFrame } from './appFrame.ts';
import { renderWizard, walkedSteps, type WizardModel, type WizardProblem } from '../components/setup/Wizard.ts';

// ── launch ──────────────────────────────────────────────────────────────────

/** Why a launch opened in setup state: the start gate's D105 body. */
export interface SetupLaunch {
  appId: string;
  /** The operational state the refusal reports, when it names one. */
  state: string | null;
  error: WizardProblem;
}

const text = (o: Record<string, unknown>, k: string): string | undefined => (typeof o[k] === 'string' ? o[k] as string : undefined);

/**
 * The setup refusal of a start answer, or null for every other answer. A
 * setup refusal is a 409 whose body is in the D105 category `needs-setup`,
 * or A1's `setup-unsupported` (an app that declares setup on an AuraOS
 * without the engine); both shapes: the bare body (`/api/apps/<id>/start`)
 * and `{kind: 'setup-required', error}` (`/api/intents/start`).
 */
export async function setupLaunchOf(res: Response, appId: string): Promise<SetupLaunch | null> {
  if (res.status !== 409) return null;
  const raw = await res.clone().json().catch(() => null) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') return null;
  const body = raw['kind'] === 'setup-required' && raw['error'] && typeof raw['error'] === 'object'
    ? raw['error'] as Record<string, unknown> : raw;
  const code = text(body, 'error');
  if (!code || (body['category'] !== 'needs-setup' && code !== 'setup-unsupported')) return null;
  const hint = text(body, 'hint');
  return {
    appId: text(raw, 'appId') ?? appId,
    state: text(body, 'state') ?? text(raw, 'state') ?? null,
    error: { error: code, message: text(body, 'message') ?? 'This app needs to be set up first.', ...(hint ? { hint } : {}) },
  };
}

export interface SetupLaunchHost {
  /** Show the launch's window in setup state: true once the setup is ready, false when the window was closed. */
  showSetup(launch: SetupLaunch): Promise<boolean>;
}

/**
 * The desktop's app start. Without setup: one `POST /api/apps/<id>/start`
 * and its response as it came (the launch path is unchanged). A setup
 * refusal: the window shows the setup, then the start runs again. Null:
 * the window was closed during the setup.
 */
export async function startWithSetup(appId: string, host: SetupLaunchHost, deps: { fetch?: typeof fetch } = {}): Promise<Response | null> {
  const f = deps.fetch ?? fetch;
  for (;;) {
    const res = await f(`/api/apps/${appId}/start`, { method: 'POST' });
    const setup = await setupLaunchOf(res, appId);
    if (!setup) return res;
    if (!(await host.showSetup(setup))) return null;
  }
}

// ── the wizard ──────────────────────────────────────────────────────────────

export interface SetupWindowOptions {
  appId: string;
  appName: string;
  /** The start refusal that opened the window. */
  launch: SetupLaunch | null;
  /** The setup reached `ready`: the window becomes the app's (the caller starts it). */
  onReady(): void;
}

export interface SetupWindowDeps {
  fetch?: typeof fetch;
  /** D102 Review: show a pending approval again in the shell's owner dialog (`window.auraOpenApproval`). */
  openApproval?(id: string): void;
  /**
   * D56 `ask`: hand a secret field to the shell's credential dialog. Answers
   * the `credential.store` approval to show, or a note when this AuraOS
   * offers no hand-off yet (see SECRET_ASK_UNAVAILABLE).
   */
  askSecret?(appId: string, field: string): Promise<{ approvalId: string } | { note: string }>;
  /** How often a run the engine drives (approval, init) is read again. */
  pollMs?: number;
}

export interface SetupWindow {
  element: HTMLElement;
  /** Stop reading and remove the view. */
  dispose(): void;
  /** Read the state again (a poll tick; tests). */
  refresh(): Promise<void>;
}

/** When the setup API can't create the owner's `credential.store` for a field (no engine yet), `ask` says so. */
export const SECRET_ASK_UNAVAILABLE = 'AuraOS cannot ask for this secret here yet: enter it with the CLI (aura secret ask, then --secret <field>=@vault:<handle>), or pick a stored one.';

const POLL_MS = 2000;
type ApiAnswer<T> = { ok: true; status: number; body: T } | { ok: false; status: number; problem: WizardProblem };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A refusal body as the wizard shows it: message, hint, reasons. Never a value (bodies carry none). */
function problemOf(body: unknown, status: number): WizardProblem {
  const b = isRecord(body) ? (isRecord(body['error']) ? body['error'] : body) : {};
  const out: WizardProblem = {
    error: text(b, 'error') ?? 'unavailable',
    message: text(b, 'message') ?? `AuraOS answered ${status}.`,
  };
  const hint = text(b, 'hint');
  if (hint) out.hint = hint;
  for (const k of ['missing', 'suggest'] as const) {
    const v = b[k];
    if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string');
  }
  if (isRecord(b['fieldErrors'])) {
    out.fieldErrors = Object.fromEntries(Object.entries(b['fieldErrors']).filter((e): e is [string, string] => typeof e[1] === 'string'));
  }
  return out;
}

/** Draw the setup wizard into an Activity window's body and run it until `ready`. */
export function mountSetupWindow(body: HTMLElement, opts: SetupWindowOptions, deps: SetupWindowDeps = {}): SetupWindow {
  const doc = body.ownerDocument;
  const f = deps.fetch ?? fetch;
  const base = `/api/apps/${encodeURIComponent(opts.appId)}/setup`;
  const root = doc.createElement('div');
  root.className = 'wz-root';
  root.dataset['auraSetupWindow'] = opts.appId;
  body.appendChild(root);

  const model: WizardModel = {
    appName: opts.appName, phase: 'loading', plan: null, step: null, state: null, profile: null, secrets: {}, handles: [],
    problem: null, note: null, approvalId: null, repair: false, busy: false,
  };
  /** The owner's proposal in this run (plain values and handles; never a secret value). */
  let values: Record<string, unknown> | undefined;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let form: SchemaForm | null = null;
  /** Did this window see the setup not ready? Only then is a `ready` a transition to the app. */
  let sawNotReady = false;
  /** A slot is filled before it is inserted: a closed window is one that was in the page and left it. */
  let wasConnected = false;

  const draw = (): void => {
    if (disposed) return;
    form = renderWizard(root, model, {
      onProfile: (id) => { model.profile = id; void replan(); },
      onNext: (input) => void next(input),
      onBack: () => { move(-1); draw(); },
      onApply: () => void apply(),
      onAskSecret: (field) => void ask(field),
      onReview: (id) => deps.openApproval?.(id),
      onOpenApp: () => finish(),
    });
  };

  async function call<T>(path: string, init?: RequestInit): Promise<ApiAnswer<T>> {
    try {
      const res = await f(`${base}${path}`, { credentials: 'same-origin', ...init });
      const data = await res.json().catch(() => null) as unknown;
      if (res.ok) return { ok: true, status: res.status, body: data as T };
      return { ok: false, status: res.status, problem: problemOf(data, res.status) };
    } catch {
      return { ok: false, status: 0, problem: { error: 'unreachable', message: 'AuraOS could not be reached.' } };
    }
  }
  const post = <T>(path: string, proposal: SetupProposal | null): Promise<ApiAnswer<T>> => call<T>(path, {
    method: 'POST',
    ...(proposal ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(proposal) } : {}),
  });

  const proposal = (): SetupProposal => ({
    ...(model.profile !== null ? { profile: model.profile } : {}),
    ...(values ? { values } : {}),
    ...(Object.keys(model.secrets).length ? { secrets: { ...model.secrets } } : {}),
  });
  const notice = (problem: WizardProblem): void => { model.phase = 'notice'; model.problem = problem; model.busy = false; draw(); };

  function move(by: -1 | 1): void {
    const walked = model.plan ? walkedSteps(model.plan.steps) : [];
    const at = model.step ? walked.indexOf(model.step) : -1;
    const to = walked[Math.min(Math.max(at + by, 0), walked.length - 1)];
    if (to) model.step = to;
  }

  /** The step to show: the recorded one when the owner walks it, else the first open one. */
  function resumeStep(plan: SetupPlan, recorded: SetupStep | null): SetupStep | null {
    const walked = walkedSteps(plan.steps);
    if (recorded && walked.includes(recorded)) return recorded;
    if (recorded === 'approval' || recorded === 'init' || recorded === 'readiness' || recorded === 'done') return walked[walked.length - 1] ?? null;
    return walked.find((s) => plan.steps.find((p) => p.step === s)?.status === 'todo') ?? walked[0] ?? null;
  }

  function finish(): void {
    if (disposed) return;
    dispose();
    opts.onReady();
  }

  function schedule(): void {
    if (disposed || timer) return;
    timer = setTimeout(() => { timer = null; void refresh(); }, deps.pollMs ?? POLL_MS);
  }

  /** Show what the engine's state says (the plan is read when the owner has steps to walk). */
  async function show(state: SetupStateView, outcome?: SetupOutcome): Promise<void> {
    if (disposed) return;
    model.state = state.state;
    if (state.state !== 'ready') sawNotReady = true;
    if (state.state === 'ready') {
      if (sawNotReady) { finish(); return; }
      // Ready by the engine, yet the start was refused: say so; the owner retries (never a loop).
      model.phase = 'refused';
      model.problem = opts.launch?.error ?? null;
      draw();
      return;
    }
    if (!model.plan || model.phase === 'loading') {
      const plan = await call<SetupPlan>('/plan');
      if (disposed) return;
      if (!plan.ok) { notice(plan.problem); return; }
      model.plan = plan.body;
      if (model.profile === null) model.profile = state.profile ?? null;
    }
    model.approvalId = outcome?.approvalId ?? state.approvalId ?? null;
    model.repair = state.state === 'repair-required';
    model.busy = false;
    if (state.state === 'awaiting-approval') { model.phase = 'pending'; model.problem = null; schedule(); }
    else if (state.state === 'initializing') { model.phase = 'progress'; model.problem = null; schedule(); }
    else if (state.state === 'blocked') { model.phase = 'blocked'; model.problem = state.error ? problemOf(state.error, 409) : null; }
    else {
      // setup-required, configuring, setup-failed, repair-required: the owner's steps.
      if (model.phase !== 'edit') model.step = resumeStep(model.plan!, state.step);
      model.phase = 'edit';
      if (state.state === 'setup-failed' && state.error && !model.problem) model.problem = problemOf(state.error, 409);
    }
    draw();
  }

  async function refresh(): Promise<void> {
    if (disposed) return;
    if (root.isConnected) wasConnected = true;
    else if (wasConnected) { dispose(); return; }
    const frame = await resolveAppFrame({ kind: 'setup', appId: opts.appId }, { fetch: f });
    if (disposed) return;
    if (!frame.state) { notice(frame.refusal ?? { error: 'unavailable', message: 'The app\'s setup state could not be read.' }); return; }
    await show(frame.state);
  }

  /** A changed proposal: the engine's plan for it (steps may appear or be skipped). */
  async function replan(): Promise<boolean> {
    model.busy = true; draw();
    const plan = await post<SetupPlan>('/plan', proposal());
    if (disposed) return false;
    model.busy = false;
    if (!plan.ok) {
      if (plan.status === 503) { notice(plan.problem); return false; }
      model.problem = plan.problem; draw(); return false;
    }
    model.plan = plan.body;
    model.problem = null;
    const walked = walkedSteps(plan.body.steps);
    if (model.step && !walked.includes(model.step)) model.step = walked[0] ?? null;
    draw();
    return true;
  }

  async function next(input: { values: Record<string, unknown>; secrets: Record<string, string> } | null): Promise<void> {
    if (model.step === 'values' && input) {
      values = input.values;
      model.secrets = { ...input.secrets };
      if (!(await replan())) return;
      // The engine checks the values; an invalid field keeps the owner here.
      if (model.plan!.fields.some((x) => x.error)) { model.problem = { error: 'config-invalid', message: 'Some fields need a change.' }; draw(); return; }
    } else if (model.step === 'profile') {
      if (!(await replan())) return;
    }
    move(1);
    draw();
  }

  async function apply(): Promise<void> {
    model.busy = true; model.problem = null; draw();
    const r = await post<SetupOutcome>(model.repair ? '/repair' : '/apply', proposal());
    if (disposed) return;
    if (!r.ok) {
      if (r.status === 503) { notice(r.problem); return; }
      model.busy = false;
      model.problem = r.problem;
      if (r.problem.fieldErrors && model.plan && walkedSteps(model.plan.steps).includes('values')) model.step = 'values';
      draw();
      return;
    }
    const outcome = r.body;
    if (outcome.status === 'ready') { finish(); return; }
    await show(outcome.state, outcome);
  }

  /** `ask` through the setup API (`POST …/setup/secrets/<field>` → the owner's credential.store request). */
  async function askLive(field: string): Promise<{ approvalId: string } | { note: string }> {
    const r = await call<{ approvalId?: unknown }>(`/secrets/${encodeURIComponent(field)}`, { method: 'POST' });
    if (r.ok && typeof r.body.approvalId === 'string') return { approvalId: r.body.approvalId };
    if (!r.ok && r.status !== 503) return { note: r.problem.message };
    return { note: SECRET_ASK_UNAVAILABLE };
  }

  /** The handles the `vault` picker offers (best effort: none when the API can't list them). */
  async function loadHandles(): Promise<void> {
    const r = await call<unknown>('/secrets');
    if (disposed || !r.ok || !Array.isArray(r.body)) return;
    model.handles = r.body.filter((h): h is { handle: string; label?: string } =>
      isRecord(h) && typeof h['handle'] === 'string' && (h['label'] === undefined || typeof h['label'] === 'string'))
      .map((h) => ({ handle: h.handle, ...(h.label ? { label: h.label } : {}) }));
    if (model.step === 'values') draw();
  }

  async function ask(field: string): Promise<void> {
    const handoff = deps.askSecret ? await deps.askSecret(opts.appId, field) : await askLive(field);
    if (disposed) return;
    if ('approvalId' in handoff) {
      model.note = 'Enter the secret in AuraOS\'s own dialog. This form never sees it.';
      deps.openApproval?.(handoff.approvalId);
    } else model.note = handoff.note;
    draw();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    root.remove();
  }

  draw();
  void refresh();
  void loadHandles();
  return { element: root, dispose, refresh };
}

