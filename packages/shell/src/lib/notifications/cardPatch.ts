/**
 * How a rendered notification card follows a store update — DOM-free.
 *
 *   'none'     nothing visible changed (e.g. only the echo of this client's
 *              own interaction: lastInteraction / updatedAt / history /
 *              displayedAt). The card is left alone.
 *   'patch'    only title, text, progress values or the seen state changed:
 *              those nodes are patched in place; inputs, options and buttons
 *              are never replaced, so typed values, the selection, focus,
 *              caret and scroll stay.
 *   'rebuild'  the structure changed (component ids / kinds / labels /
 *              options, type, priority, image, context, sender, pinned):
 *              a full re-render, which still carries the values over.
 *
 * Also: in a dialogue (`mode:'dialog'`) form controls are local form state —
 * changing an input or option sends nothing; values go with a button
 * (resolve `{buttonId, values}`, or interact for a button without action).
 * The schema has no "submit on change" flag, so there is none here.
 */
import type { Notification } from './api.ts';

export type CardUpdatePlan = 'none' | 'patch' | 'rebuild';
export type CardMode = 'list' | 'toast' | 'dialog';

type Comp = NonNullable<Notification['components']>[number];

/** Everything whose change needs a full re-render. */
export function structureKey(n: Notification): string {
  const comps = (n.components ?? []).map((c: Comp) => (c.kind === 'progress'
    ? { kind: 'progress', id: c.id ?? null }   // value / label are patched
    : c));
  return JSON.stringify({
    type: n.type, state: n.state, priority: n.priority, pinned: !!n.pinned,
    icon: n.icon ?? null, image: n.image ?? null, context: n.context ?? null,
    sender: n.sender, comps,
  });
}

function progressKey(n: Notification): string {
  return JSON.stringify((n.components ?? []).filter((c) => c.kind === 'progress')
    .map((c) => (c.kind === 'progress' ? [c.value, c.label ?? null] : null)));
}

export function planCardUpdate(prev: Notification | undefined, next: Notification): CardUpdatePlan {
  if (!prev || prev.id !== next.id) return 'rebuild';
  if (structureKey(prev) !== structureKey(next)) return 'rebuild';
  const patch = prev.title !== next.title
    || prev.text !== next.text
    || progressKey(prev) !== progressKey(next)
    || (prev.seenAt === undefined) !== (next.seenAt === undefined)
    || prev.createdAt !== next.createdAt;
  return patch ? 'patch' : 'none';
}

/**
 * Required-field validation runs only for SUBMITTING buttons: `resolve`, and
 * a button without an action (interact with values). Cancel-type buttons
 * (`dismiss`), `link` buttons, the header ✕ and Escape never validate and
 * send no values. (A "Cancel" built as a resolve button cannot be told
 * apart today — see the phase-6 note on a button role.)
 */
export function buttonValidates(b: { action?: 'resolve' | 'dismiss' | 'link' | undefined; role?: 'submit' | 'cancel' | 'later' | undefined }): boolean {
  if (b.role) return b.role === 'submit';
  return b.action === 'resolve' || b.action === undefined;
}

type RequiredField = Extract<Comp, { kind: 'input' | 'select' | 'combobox' }>;

/** Required inputs / selects / comboboxes that are empty (whitespace counts as empty). */
export function missingRequired(
  components: Notification['components'], values: Record<string, string | string[]>,
): RequiredField[] {
  return (components ?? []).filter((x): x is RequiredField =>
    (x.kind === 'input' || x.kind === 'select' || x.kind === 'combobox') && !!x.required && !String(values[x.id] ?? '').trim());
}

/**
 * Field errors from a failed server answer (400 with zod-style details
 * `[{path, message}]`): every component id that appears as a path segment.
 */
export function fieldErrorsFrom(details: unknown, components: Notification['components']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(details)) return out;
  const ids = new Set((components ?? []).map((c) => c.id).filter((x): x is string => !!x));
  for (const d of details) {
    if (!d || typeof d !== 'object') continue;
    const path = String((d as { path?: unknown }).path ?? '').split('.');
    const msg = String((d as { message?: unknown }).message ?? 'Invalid');
    const hit = path.find((seg) => ids.has(seg));
    if (hit && !out[hit]) out[hit] = msg;
  }
  return out;
}

/** Do field / option changes send an `interact`? Not in a dialogue. */
export function sendsOnFieldChange(mode: CardMode): boolean {
  return mode !== 'dialog';
}
