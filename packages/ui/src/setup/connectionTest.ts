/**
 * The connection test: the app's `onValidate` answer (`ValidateResult`),
 * run by the caller through the setup API. The checks and field messages
 * are the app's own words and are labelled so (D49). The result cannot
 * change the setup state; it only informs the owner.
 */
import type { ValidateResult } from '@aura/core';
import { button, el, section } from './dom.js';

export interface ConnectionTestProps {
  /** The last answer; null: not tested yet. */
  result: ValidateResult | null;
  /** A test is running (the button is disabled). */
  running?: boolean;
  disabled?: boolean;
}

export function renderConnectionTest(root: HTMLElement, props: ConnectionTestProps, on: { onTest(): void }): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const s = section(doc, 'connection-test', 'Connection test');
  const b = button(doc, 'btn', props.running ? 'TESTING…' : 'TEST', () => on.onTest());
  b.dataset['action'] = 'test-connection';
  b.disabled = props.running === true || props.disabled === true;
  s.append(b);
  const r = props.result;
  if (r) {
    const verdict = el(doc, 'p', r.ok ? 'su-ok' : 'su-no', r.ok ? 'The app reports: everything works.' : 'The app reports a problem.');
    verdict.dataset['testOk'] = String(r.ok);
    s.append(verdict);
    const ul = el(doc, 'ul', 'su-list');
    for (const c of r.checks ?? []) {
      const li = el(doc, 'li', 'su-item');
      li.dataset['check'] = c.id;
      li.dataset['status'] = c.ok ? 'met' : 'unmet';
      li.append(el(doc, 'span', 'su-item-title', c.id), el(doc, 'span', c.ok ? 'su-ok' : 'su-no', c.ok ? 'ok' : 'failed'));
      if (c.message) li.append(el(doc, 'span', 'su-item-desc', `The app says: ${c.message}`));
      ul.append(li);
    }
    for (const [field, message] of Object.entries(r.fieldErrors ?? {})) {
      const li = el(doc, 'li', 'su-item');
      li.dataset['fieldError'] = field;
      li.dataset['status'] = 'unmet';
      li.append(el(doc, 'span', 'su-item-title', field), el(doc, 'span', 'su-item-desc', `The app says: ${message}`));
      ul.append(li);
    }
    if (ul.children.length) s.append(ul);
  }
  root.append(s);
}
