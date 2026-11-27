/**
 * The setup progress stepper: the plan's steps (`SetupPlanStep[]`, dynamic:
 * skipped steps stay visible as skipped) and the one the run is at. The
 * engine decides the steps and their status; this only shows them.
 */
import type { SetupPlanStep, SetupStep } from '@aura/core';
import { el } from './dom.js';

const STATUS_TEXT: Record<SetupPlanStep['status'], string> = { todo: 'to do', done: 'done', skipped: 'skipped', blocked: 'blocked' };

export function renderProgress(root: HTMLElement, props: { steps: readonly SetupPlanStep[]; current: SetupStep | null }): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const ol = el(doc, 'ol', 'su-steps');
  ol.dataset['setup'] = 'progress';
  props.steps.forEach((s, i) => {
    const li = el(doc, 'li', s.step === props.current ? 'su-step su-step-current' : 'su-step');
    li.dataset['step'] = s.step;
    li.dataset['status'] = s.status;
    if (s.step === props.current) li.setAttribute('aria-current', 'step');
    li.append(el(doc, 'span', 'su-step-n', String(i + 1)), el(doc, 'span', 'su-step-title', s.title), el(doc, 'span', 'su-step-status', STATUS_TEXT[s.status]));
    ol.append(li);
  });
  root.append(ol);
}
