/**
 * `aura admin dev system-decision` — build the payload for the DEV-only
 * AuraOS desktop-decision hook (POST /api/admin/dev/system-decision). Pure,
 * unit tested. The shell forces `type:'dialogue', scope:'desktop'` and
 * validates the rest with the normal notification schema.
 */
export interface SystemDecisionOpts {
  title?: string;
  text?: string;
  priority?: string;
  /** true → one "Reason" input; a string → comma-separated input labels. */
  inputs?: boolean | string;
  /** true → Allow / Deny / Later choices; a string → comma-separated labels. */
  options?: boolean | string;
  cancelLabel?: string;
  submitLabel?: string;
  /** A full notification input (JSON); flags above override its fields. */
  json?: string;
}

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

export function slugId(label: string, i: number, taken: Set<string>): string {
  let base = label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `o${i + 1}`;
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}

const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

export function buildSystemDecisionPayload(o: SystemDecisionOpts): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  if (o.json !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(o.json); } catch (err) { throw new Error(`--json is not valid JSON: ${(err as Error).message}`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--json must be a JSON object (a notification input)');
    base = { ...(parsed as Record<string, unknown>) };
  }
  if (o.title !== undefined) base['title'] = o.title;
  if (o.text !== undefined) base['text'] = o.text;
  if (o.priority !== undefined) {
    if (!PRIORITIES.includes(o.priority)) throw new Error(`--priority must be one of ${PRIORITIES.join(' | ')}`);
    base['priority'] = o.priority;
  }
  const flagsBuildComponents = o.inputs !== undefined || o.options !== undefined || o.cancelLabel !== undefined || o.submitLabel !== undefined;
  if (flagsBuildComponents) {
    const comps: Array<Record<string, unknown>> = Array.isArray(base['components']) && o.json !== undefined
      ? (base['components'] as Array<Record<string, unknown>>).filter((c) => c['kind'] !== 'button' || !c['role'])
      : [];
    const taken = new Set(comps.map((c) => String(c['id'] ?? '')));
    if (o.options !== undefined && o.options !== false) {
      const labels = o.options === true ? ['Allow', 'Deny', 'Ask me later'] : list(o.options);
      if (!labels.length) throw new Error('--options needs at least one label');
      if (labels.length > 8) throw new Error('--options allows at most 8 choices');
      comps.push({
        kind: 'options', id: slugId('choice', 0, taken), label: 'Choose',
        ...(labels.length > 4 ? { display: 'radio' } : {}),
        options: labels.map((l, i) => ({ id: slugId(l, i, new Set()), label: l })),
      });
    }
    if (o.inputs !== undefined && o.inputs !== false) {
      const labels = o.inputs === true ? ['Reason'] : list(o.inputs);
      labels.forEach((l, i) => comps.push({ kind: 'input', id: slugId(l, i, taken), label: l }));
    }
    comps.push({ kind: 'button', role: 'cancel', ...(o.cancelLabel ? { label: o.cancelLabel } : {}) });
    comps.push({ kind: 'button', role: 'submit', ...(o.submitLabel ? { label: o.submitLabel } : {}) });
    base['components'] = comps;
  }
  return base;
}

/** One line for `--wait`: the outcome and the values. */
export function describeDecision(n: { state: string; outcome?: string; answer?: unknown; removedReason?: string }): string {
  if (n.state === 'resolved') {
    const a = (n.answer && typeof n.answer === 'object' ? n.answer : {}) as Record<string, unknown>;
    const vals = a['values'] && typeof a['values'] === 'object' ? ` values ${JSON.stringify(a['values'])}` : '';
    return `${n.outcome ?? 'submitted'}${a['buttonId'] ? ` (button ${String(a['buttonId'])})` : ''}${vals}`;
  }
  if (n.state === 'removed') return `removed (${n.removedReason ?? 'removed'})`;
  return 'pending';
}

/** `aura admin notif release <id> | --app <appId>` → the route body (exactly one target). */
export function releaseBody(id: string | undefined, opts: { app?: string }): { id: string } | { appId: string } {
  if (id && opts.app) throw new Error('give a notification id OR --app <appId>, not both');
  if (id) {
    if (!/^ntf_[a-z0-9]{9,20}$/.test(id)) throw new Error(`'${id}' is not a notification id (ntf_…)`);
    return { id };
  }
  if (opts.app) return { appId: opts.app };
  throw new Error('aura admin notif release <id> | --app <appId>');
}
