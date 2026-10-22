/**
 * The button row of a notification — DOM-free (phase 4).
 *
 * Standard dialogue buttons (`role`):
 *   submit  primary; validates required fields; resolves
 *           `{outcome:'submitted', buttonId, values}`
 *   cancel  no validation / values; resolves `{outcome:'cancelled', buttonId}`
 *   later   local: hides the dialogue (it stays in the list with Answer);
 *           only where it can be put off (not blocking / desktop decisions)
 * A dialogue always gets all three: missing ones are added with default text
 * (submit: "Submit" with inputs / options / selects, else "OK"; "Cancel"; "Later").
 * A sender's role button replaces the default and may bring its own label.
 * Legacy buttons keep their meaning: `action:'resolve'` acts as a submit
 * (and so suppresses the default submit), `action:'dismiss'` as the old
 * cancel (dismisses; suppresses the default cancel), `link` opens href, no
 * action → interact with values.
 *
 * Order: custom buttons (sender order), then Later, Cancel, Submit — the
 * primary last / right (stacked on the phone).
 */
import type { Notification } from './api.ts';

type Comp = NonNullable<Notification['components']>[number];
export type ButtonComp = Extract<Comp, { kind: 'button' }>;

export type ButtonBehaviour = 'submit' | 'cancel' | 'later' | 'resolve' | 'dismiss' | 'link' | 'interact';

export interface PlannedButton {
  id: string;
  label: string;
  variant: 'primary' | 'secondary' | 'tertiary';
  behaviour: ButtonBehaviour;
  /** The sender's component (absent for an added default). */
  source?: ButtonComp;
  href?: string;
}

export function hasFields(n: Pick<Notification, 'components'>): boolean {
  return (n.components ?? []).some((c) => c.kind === 'input' || c.kind === 'options' || c.kind === 'select' || c.kind === 'combobox');
}

export function defaultLabel(role: 'submit' | 'cancel' | 'later', n: Pick<Notification, 'components'>): string {
  if (role === 'submit') return hasFields(n) ? 'Submit' : 'OK';
  return role === 'cancel' ? 'Cancel' : 'Later';
}

export function behaviourOf(b: ButtonComp): ButtonBehaviour {
  if (b.role) return b.role;
  if (b.action === 'resolve') return 'resolve';
  if (b.action === 'dismiss') return 'dismiss';
  if (b.action === 'link') return 'link';
  return 'interact';
}

/** Does this button check required fields first? Only submitting ones. */
export function behaviourValidates(b: ButtonBehaviour): boolean {
  return b === 'submit' || b === 'resolve' || b === 'interact';
}

export function planButtons(n: Pick<Notification, 'type' | 'components'>, opts: { canPutOff: boolean }): PlannedButton[] {
  const senderButtons = (n.components ?? []).filter((c): c is ButtonComp => c.kind === 'button');
  const ids = new Set(senderButtons.map((b) => b.id ?? b.role ?? ''));
  const free = (want: string) => (ids.has(want) ? `__${want}` : want);
  const custom: PlannedButton[] = [];
  const special: Partial<Record<'submit' | 'cancel' | 'later', PlannedButton>> = {};
  let legacySubmit = false;
  let legacyCancel = false;
  for (const b of senderButtons) {
    const behaviour = behaviourOf(b);
    const id = b.id ?? b.role ?? '';
    if (behaviour === 'submit' || behaviour === 'cancel' || behaviour === 'later') {
      if (special[behaviour]) continue;           // core allows one per role
      special[behaviour] = {
        id, behaviour, source: b,
        label: b.label?.trim() || defaultLabel(behaviour, n),
        variant: behaviour === 'submit' ? 'primary' : behaviour === 'cancel' ? 'secondary' : 'tertiary',
      };
      continue;
    }
    if (behaviour === 'resolve') legacySubmit = true;
    if (behaviour === 'dismiss') legacyCancel = true;
    custom.push({
      id, behaviour, source: b, label: b.label ?? id, variant: b.variant ?? 'secondary',
      ...(b.href ? { href: b.href } : {}),
    });
  }
  if (n.type === 'dialogue') {
    if (!special.submit && !legacySubmit) special.submit = { id: free('submit'), behaviour: 'submit', label: defaultLabel('submit', n), variant: 'primary' };
    if (!special.cancel && !legacyCancel) special.cancel = { id: free('cancel'), behaviour: 'cancel', label: 'Cancel', variant: 'secondary' };
    if (!special.later) special.later = { id: free('later'), behaviour: 'later', label: 'Later', variant: 'tertiary' };
  }
  if (!opts.canPutOff) delete special.later;
  return [
    ...custom,
    ...(special.later ? [special.later] : []),
    ...(special.cancel ? [special.cancel] : []),
    ...(special.submit ? [special.submit] : []),
  ];
}

/** The answer a resolving button sends. */
export function answerFor(b: PlannedButton, values: Record<string, string | string[]>): Record<string, unknown> | null {
  if (b.behaviour === 'submit' || b.behaviour === 'resolve') return { outcome: 'submitted', buttonId: b.id, values };
  if (b.behaviour === 'cancel') return { outcome: 'cancelled', buttonId: b.id };
  return null;
}
