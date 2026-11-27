/**
 * The setup wizard's view (D108 W1): what the shell draws inside an app's
 * Activity window while the app is not ready. Plain DOM, built at runtime
 * from the setup API's plain data; the components are the one library
 * `@aura/ui/setup` (W2), no second renderer. Presentation only: the steps,
 * their status, the fields, the requirements and the approval preview are
 * the engine's (`SetupPlan`); this decides nothing. The controller
 * (lib/setupWindow.ts) owns fetching, the run and the transition to the app.
 *
 * Never a value of a secret (the picker holds vault handles only) and never
 * a control that approves: an approval is the owner's dialog (D102).
 * Styles: WizardStyles.astro (`wz-*`) and `@aura/ui/styles/setup.css`
 * (`su-*`, `sf-*`); hooks are `data-*` attributes.
 */
import {
  renderApprovalSummary, renderDependencies, renderFieldViews, renderProfileSelector, renderProgress,
  type SchemaForm, type SecretFieldOptions,
} from '@aura/ui/setup';
import type { SetupPlan, SetupPlanStep, SetupStep } from '@aura/core';

/** A refusal or failure as the wizard shows it (a D105 body: message, hint, reasons; never a value). */
export interface WizardProblem {
  error: string;
  message: string;
  hint?: string;
  missing?: string[];
  suggest?: string[];
  fieldErrors?: Record<string, string>;
}

/**
 * What the window shows:
 *   loading   reading the setup state
 *   notice    the setup API refused (503 `unavailable` without an engine): a notice, no stepper
 *   edit      one of the owner's steps (profile, values, requirements, review)
 *   pending   the engine's `app.setup.apply` approval waits for the owner (202 on-hold)
 *   progress  the engine initializes the app (its state, nothing invented)
 *   blocked   the setup cannot complete here (reasons only)
 *   refused   the setup says ready, but AuraOS refused to start the app
 */
export type WizardPhase = 'loading' | 'notice' | 'edit' | 'pending' | 'progress' | 'blocked' | 'refused';

export interface WizardModel {
  appName: string;
  phase: WizardPhase;
  plan: SetupPlan | null;
  /** The owner's step in `edit`. */
  step: SetupStep | null;
  /** The engine's state word, shown in `progress`/`blocked`. */
  state: string | null;
  /** The profile chosen in this run (or recorded). */
  profile: string | null;
  /** field → vault handle picked in this run (names only). */
  secrets: Record<string, string>;
  problem: WizardProblem | null;
  /** A short note (e.g. what happened to a secret hand-off). */
  note: string | null;
  approvalId: string | null;
  /** The review step applies as a repair (`repair-required`). */
  repair: boolean;
  busy: boolean;
}

export interface WizardCallbacks {
  onProfile(id: string): void;
  /** Next from a step; on `values` with the form's values and picked handles. */
  onNext(form: { values: Record<string, unknown>; secrets: Record<string, string> } | null): void;
  onBack(): void;
  onApply(): void;
  onAskSecret(field: string): void;
  /** Re-show a pending approval in the owner's dialog (D102 Review). It never approves. */
  onReview(approvalId: string): void;
  /** Try to start the app again (`refused`). */
  onOpenApp(): void;
}

/** The owner's steps in the window, in the plan's order; skipped ones are not walked. */
export const OWNER_STEPS: readonly SetupStep[] = ['profile', 'values', 'requirements', 'review'];

/** The owner's steps of a plan that are walked (not skipped), in order. */
export function walkedSteps(steps: readonly SetupPlanStep[]): SetupStep[] {
  return steps.filter((s) => OWNER_STEPS.includes(s.step) && s.status !== 'skipped').map((s) => s.step);
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function action(doc: Document, name: string, text: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = el(doc, 'button', primary ? 'wz-btn wz-btn-primary' : 'wz-btn', text);
  b.type = 'button';
  b.dataset['action'] = name;
  b.addEventListener('click', onClick);
  return b;
}

function problemBox(doc: Document, p: WizardProblem): HTMLElement {
  const box = el(doc, 'div', 'wz-problem');
  box.dataset['problem'] = p.error;
  box.setAttribute('role', 'alert');
  box.append(el(doc, 'p', 'wz-problem-text', p.message));
  if (p.hint) box.append(el(doc, 'p', 'wz-problem-hint', p.hint));
  if (p.missing?.length) box.append(el(doc, 'p', 'wz-problem-hint', `Missing: ${p.missing.join(', ')}`));
  if (p.suggest?.length) box.append(el(doc, 'p', 'wz-problem-hint', `Could work instead: ${p.suggest.join(', ')}`));
  return box;
}

/**
 * Draw `model` into `root` (replacing its children). Returns the values form
 * while the `values` step is shown (the controller reads it on Next).
 */
export function renderWizard(root: HTMLElement, model: WizardModel, on: WizardCallbacks): SchemaForm | null {
  const doc = root.ownerDocument;
  root.replaceChildren();
  root.dataset['phase'] = model.phase;
  root.setAttribute('aria-busy', String(model.busy || model.phase === 'loading'));

  const head = el(doc, 'header', 'wz-head');
  head.append(el(doc, 'h2', 'wz-title', `Set up ${model.appName}`));
  head.append(el(doc, 'p', 'wz-sub', 'AuraOS sets this app up before it opens. Nothing of the app runs until the setup is complete.'));
  root.append(head);

  if (model.phase === 'loading') {
    root.append(el(doc, 'p', 'wz-note', 'Reading the app\'s setup…'));
    return null;
  }
  if (model.phase === 'notice') {
    const box = el(doc, 'section', 'wz-notice');
    box.dataset['notice'] = model.problem?.error ?? 'unavailable';
    box.append(el(doc, 'h3', 'wz-notice-title', 'App setup is not available'));
    if (model.problem) box.append(problemBox(doc, model.problem));
    root.append(box);
    return null;
  }

  const plan = model.plan;
  if (plan) {
    const stepper = el(doc, 'nav', 'wz-steps');
    stepper.setAttribute('aria-label', 'Setup steps');
    const current: SetupStep | null = model.phase === 'edit' ? model.step
      : model.phase === 'pending' ? 'approval' : model.phase === 'progress' ? 'init' : null;
    renderProgress(stepper, { steps: plan.steps, current });
    root.append(stepper);
  }

  const main = el(doc, 'div', 'wz-body');
  root.append(main);
  if (model.problem) main.append(problemBox(doc, model.problem));
  if (model.note) {
    const note = el(doc, 'p', 'wz-note', model.note);
    note.dataset['note'] = '';
    main.append(note);
  }
  const actions = el(doc, 'div', 'wz-actions');
  let form: SchemaForm | null = null;

  switch (model.phase) {
    case 'pending': {
      const s = el(doc, 'section', 'wz-pending');
      s.dataset['pendingApproval'] = model.approvalId ?? '';
      s.append(el(doc, 'h3', 'wz-step-title', 'Waiting for your approval'));
      s.append(el(doc, 'p', 'wz-note', 'AuraOS asks you in its own approval dialog. This window continues by itself once you decide.'));
      if (plan?.approval) {
        const preview = el(doc, 'div');
        renderApprovalSummary(preview, { payload: plan.approval, appName: model.appName });
        s.append(preview);
      }
      main.append(s);
      if (model.approvalId) {
        const id = model.approvalId;
        actions.append(action(doc, 'review-approval', 'SHOW REQUEST', () => on.onReview(id)));
      }
      break;
    }
    case 'progress': {
      const s = el(doc, 'section', 'wz-progress');
      s.dataset['state'] = model.state ?? '';
      s.append(el(doc, 'h3', 'wz-step-title', 'Preparing the app'));
      s.append(el(doc, 'p', 'wz-note', `AuraOS reports: ${model.state ?? 'working'}. The app opens here when it is ready.`));
      main.append(s);
      break;
    }
    case 'blocked': {
      const s = el(doc, 'section', 'wz-blocked');
      s.dataset['state'] = model.state ?? '';
      s.append(el(doc, 'h3', 'wz-step-title', 'This app cannot be set up here now'));
      if (plan?.blocking.length) for (const b of plan.blocking) s.append(problemBox(doc, b));
      main.append(s);
      break;
    }
    case 'refused': {
      main.append(el(doc, 'p', 'wz-note', 'The setup reports this app ready, but AuraOS did not start it.'));
      actions.append(action(doc, 'open-app', 'OPEN APP', () => on.onOpenApp(), true));
      break;
    }
    case 'edit': {
      if (!plan || !model.step) break;
      const walked = walkedSteps(plan.steps);
      const at = walked.indexOf(model.step);
      const section = el(doc, 'div', 'wz-step');
      section.dataset['wizardStep'] = model.step;
      main.append(section);
      if (model.step === 'profile') {
        renderProfileSelector(section, { profiles: plan.profiles, selected: model.profile, disabled: model.busy }, { onSelect: (id) => on.onProfile(id) });
      } else if (model.step === 'values') {
        form = renderFieldViews(section, plan.fields, {
          profile: model.profile,
          disabled: model.busy,
          secrets: { handles: [], bound: model.secrets, onAsk: (name: string) => on.onAskSecret(name) } satisfies SecretFieldOptions,
        });
      } else if (model.step === 'requirements') {
        renderDependencies(section, { dependencies: [], requirements: plan.requirements, degraded: plan.degraded });
      } else {
        renderApprovalSummary(section, { payload: plan.approval, appName: model.appName });
        if (plan.blocking.length) for (const b of plan.blocking) section.append(problemBox(doc, b));
      }
      if (at > 0) actions.append(action(doc, 'back', 'BACK', () => on.onBack()));
      const status = plan.steps.find((s) => s.step === model.step)?.status;
      if (model.step === 'review') {
        const apply = action(doc, 'apply', model.repair ? 'REPAIR' : 'APPLY', () => on.onApply(), true);
        apply.disabled = model.busy || plan.blocking.length > 0;
        actions.append(apply);
      } else {
        const next = action(doc, 'next', 'NEXT', () => on.onNext(form ? { values: form.read(), secrets: form.secrets() } : null), true);
        next.disabled = model.busy || status === 'blocked' || (model.step === 'profile' && plan.profiles.length > 0 && !model.profile);
        actions.append(next);
      }
      break;
    }
    default: break;
  }
  if (actions.children.length) root.append(actions);
  return form;
}
