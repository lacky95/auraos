/**
 * Zod input schemas for the notification API. Validated at the boundary
 * (`NotificationService` parses every input, so in-process callers get the
 * same checks as the REST routes).
 *
 * Identity is NOT part of any input: `caller`, `verification`, every
 * `attribution`, `sender.kind` / `sender.id` are stripped (zod's default
 * `strip`) and reported back as `ignored-field` warnings by
 * `identityOverrideWarnings()`.
 */
import { z } from 'zod';
import type { NotificationWarning } from './types.js';

const ComponentId = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'ids are 1–64 chars of [A-Za-z0-9_.-]');
const ShortText = z.string().max(200);

export const InputComponentSchema = z.object({
  kind: z.literal('input'),
  id: ComponentId,
  label: ShortText.optional(),
  placeholder: ShortText.optional(),
  multiline: z.boolean().optional(),
  required: z.boolean().optional(),
});

export const OptionsComponentSchema = z.object({
  kind: z.literal('options'),
  id: ComponentId,
  label: ShortText.optional(),
  multiple: z.boolean().optional(),
  options: z.array(z.object({ id: ComponentId, label: ShortText.min(1) })).min(1).max(4),
});

/** A choice of a select / combobox (phase 6). */
const ChoiceSchema = z.object({ id: ComponentId, label: ShortText.min(1) });
export const MAX_SELECT_OPTIONS = 50;
/** Longest free text a combobox with `allowCustom` accepts. */
export const MAX_COMBOBOX_CUSTOM = 200;

/**
 * Phase 6: a dropdown — one choice out of up to 50. The value is the chosen
 * option id. `default` (an option id) is preselected; `required` makes the
 * shell ask for a choice before Submit.
 */
export const SelectComponentSchema = z.object({
  kind: z.literal('select'),
  id: ComponentId,
  label: ShortText.optional(),
  placeholder: ShortText.optional(),
  required: z.boolean().optional(),
  default: ComponentId.optional(),
  options: z.array(ChoiceSchema).min(1).max(MAX_SELECT_OPTIONS),
});

/**
 * Phase 6: a searchable select. The user filters the up to 50 options by
 * typing; with `allowCustom` the typed text itself (1–200 chars) is a valid
 * answer too. The value is an option id, or — only with `allowCustom` — the
 * free text (a value equal to an option id always means that option).
 * Without `allowCustom` it needs at least one option.
 */
export const ComboboxComponentSchema = z.object({
  kind: z.literal('combobox'),
  id: ComponentId,
  label: ShortText.optional(),
  placeholder: ShortText.optional(),
  required: z.boolean().optional(),
  allowCustom: z.boolean().optional(),
  /** An option id, or (with `allowCustom`) a free text. */
  default: z.string().min(1).max(MAX_COMBOBOX_CUSTOM).optional(),
  options: z.array(ChoiceSchema).max(MAX_SELECT_OPTIONS),
});

/**
 * A button. Phase 4: `role` marks the standard dialogue buttons —
 *   submit  validates required fields, resolves `{outcome:'submitted', buttonId, values}`
 *   cancel  no validation / values, resolves `{outcome:'cancelled', buttonId}`
 *   later   local only: hides the dialogue, nothing is sent
 * A role button may leave out `label` (the shell's default text) and `id`
 * (defaults to the role). Custom buttons (no role) need both. `action` stays
 * for compatibility; on a role button the role decides.
 */
export const BUTTON_ROLES = ['submit', 'cancel', 'later'] as const;
export const ButtonComponentSchema = z.object({
  kind: z.literal('button'),
  id: ComponentId.optional(),
  label: ShortText.min(1).optional(),
  variant: z.enum(['primary', 'secondary', 'tertiary']).default('secondary'),
  action: z.enum(['resolve', 'dismiss', 'link']).optional(),
  role: z.enum(BUTTON_ROLES).optional(),
  href: z.string().max(2048).optional(),
});

export const ProgressComponentSchema = z.object({
  kind: z.literal('progress'),
  id: ComponentId.optional(),
  value: z.number().min(0).max(1).nullable().default(null),
  label: ShortText.optional(),
});

export const ComponentSchema = z.discriminatedUnion('kind', [
  InputComponentSchema,
  OptionsComponentSchema,
  SelectComponentSchema,
  ComboboxComponentSchema,
  ButtonComponentSchema,
  ProgressComponentSchema,
]);

const ComponentsSchema = z.array(ComponentSchema).max(8).superRefine((list, ctx) => {
  const seen = new Set<string>();
  const roles = new Set<string>();
  list.forEach((c, i) => {
    let id = c.id;
    if (c.kind === 'button') {
      if (!c.role && !c.label) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'label'], message: 'a button without a role needs a label' });
      if (!c.role && !c.id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'id'], message: 'a button without a role needs an id' });
      if (c.role) {
        if (roles.has(c.role)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'role'], message: `only one '${c.role}' button` });
        roles.add(c.role);
      }
      id ??= c.role;
    }
    if (c.kind === 'options' || c.kind === 'select' || c.kind === 'combobox') {
      const ids = new Set<string>();
      c.options.forEach((o, j) => {
        if (ids.has(o.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'options', j, 'id'], message: `duplicate option id '${o.id}'` });
        ids.add(o.id);
      });
      if (c.kind === 'select' && c.default !== undefined && !ids.has(c.default)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'default'], message: `default '${c.default}' is not an option of '${c.id}'` });
      }
      if (c.kind === 'combobox') {
        if (!c.allowCustom && c.options.length === 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'options'], message: 'a combobox without allowCustom needs at least one option' });
        }
        if (!c.allowCustom && c.default !== undefined && !ids.has(c.default)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'default'], message: `default '${c.default}' is not an option of '${c.id}' (set allowCustom for free text)` });
        }
      }
    }
    if (!id) return;
    if (seen.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate component id '${id}'` });
    seen.add(id);
  });
}).transform((list) => list.map((c) => (c.kind === 'button'
  // superRefine guarantees an id or a role.
  ? { ...c, id: (c.id ?? c.role) as string }
  : c)));

export const ContextSchema = z.object({
  kind: z.enum(['activity', 'instance', 'task', 'installation', 'app', 'custom']),
  id: z.string().min(1).max(200),
  appId: z.string().max(200).optional(),
  label: ShortText.optional(),
});

/** The only sender fields a client may set (display hints, marked declared/unverified). */
export const SenderInputSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  icon: z.string().max(2048).optional(),
  actor: z.object({ name: z.string().min(1).max(100) }).optional(),
});

const ContentFields = {
  title: z.string().min(1).max(200),
  text: z.string().max(4000),
  icon: z.string().max(2048).optional(),
  image: z.string().max(2048).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  visibility: z.enum(['public', 'private', 'secret']),
  publicTitle: z.string().max(200).optional(),
  publicText: z.string().max(4000).optional(),
  /** Auto-remove (reason `expired`) after this many ms. Default: never. */
  timeoutMs: z.number().int().positive().max(30 * 24 * 3600 * 1000),
  pinned: z.boolean(),
  /**
   * How long the shell shows the POP-UP (not the notification's lifetime —
   * that is `timeoutMs`). An integer up to 24 h: > 0 → hide after that many
   * ms (the item stays in the list); 0 or any negative (normalised to -1) →
   * the pop-up stays until it is dismissed, opened, answered, removed or
   * expired. Absent → the shell default (8 s for low / medium; high / urgent
   * stay until handled).
   */
  popupDurationMs: z.number().int().max(24 * 3600 * 1000).transform((v) => (v < 0 ? -1 : v)),
  /** Dialogue only; system-gated in phase 1. */
  popup: z.boolean(),
  /** Dialogue only (phase 4): block only the sender's own window. */
  blocking: z.boolean(),
  /** Dialogue only (phase 4): `desktop` is reserved for SYSTEM_CALLER. */
  scope: z.enum(['auto', 'desktop']),
  components: ComponentsSchema,
  context: ContextSchema,
};

export const CreateInputSchema = z.object({
  type: z.enum(['simple', 'locked', 'dialogue']).default('simple'),
  title: ContentFields.title,
  text: ContentFields.text.default(''),
  icon: ContentFields.icon,
  image: ContentFields.image,
  priority: ContentFields.priority.default('medium'),
  visibility: ContentFields.visibility.default('private'),
  publicTitle: ContentFields.publicTitle,
  publicText: ContentFields.publicText,
  timeoutMs: ContentFields.timeoutMs.optional(),
  pinned: ContentFields.pinned.default(false),
  popupDurationMs: ContentFields.popupDurationMs.optional(),
  popup: ContentFields.popup.default(false),
  blocking: ContentFields.blocking.default(false),
  scope: ContentFields.scope.default('auto'),
  components: ContentFields.components.optional(),
  context: ContentFields.context.optional(),
  sender: SenderInputSchema.optional(),
});
export type CreateInput = z.input<typeof CreateInputSchema>;
export type ParsedCreateInput = z.output<typeof CreateInputSchema>;

/** Sender op. `type` is immutable; `null` clears an optional field. */
export const UpdatePatchSchema = z.object({
  title: ContentFields.title.optional(),
  text: ContentFields.text.optional(),
  icon: ContentFields.icon.nullable(),
  image: ContentFields.image.nullable(),
  priority: ContentFields.priority.optional(),
  visibility: ContentFields.visibility.optional(),
  publicTitle: ContentFields.publicTitle.nullable(),
  publicText: ContentFields.publicText.nullable(),
  /** Restarts the timeout from now; `null` removes it. */
  timeoutMs: ContentFields.timeoutMs.nullable().optional(),
  pinned: ContentFields.pinned.optional(),
  /** `null` goes back to the shell default. */
  popupDurationMs: ContentFields.popupDurationMs.nullable().optional(),
  popup: ContentFields.popup.optional(),
  blocking: ContentFields.blocking.optional(),
  scope: ContentFields.scope.optional(),
  components: ContentFields.components.nullable().optional(),
  context: ContentFields.context.nullable().optional(),
  sender: SenderInputSchema.optional(),
}).partial();
export type UpdatePatch = z.input<typeof UpdatePatchSchema>;
export type ParsedUpdatePatch = z.output<typeof UpdatePatchSchema>;

/** Answer of a dialogue (button / options / input values). Any JSON, ≤ 16 KB. */
export const AnswerSchema = z.unknown().superRefine((v, ctx) => {
  let size = 0;
  try { size = JSON.stringify(v ?? null).length; } catch { size = Infinity; }
  if (size > 16_384) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'answer exceeds 16 KB of JSON' });
  // Phase 4: `answer.outcome` (when given) must be a known outcome.
  if (v && typeof v === 'object' && !Array.isArray(v) && 'outcome' in v) {
    const o = (v as Record<string, unknown>)['outcome'];
    if (o !== 'submitted' && o !== 'cancelled') ctx.addIssue({ code: z.ZodIssueCode.custom, message: "answer.outcome must be 'submitted' or 'cancelled'" });
  }
});

/** How a dialogue was answered (phase 4). A resolve without an outcome counts as submitted. */
export const OUTCOMES = ['submitted', 'cancelled'] as const;
export function outcomeOf(answer: unknown): 'submitted' | 'cancelled' {
  if (answer && typeof answer === 'object' && !Array.isArray(answer) && (answer as Record<string, unknown>)['outcome'] === 'cancelled') return 'cancelled';
  return 'submitted';
}

/** Body of `POST …/<id>/interact` (validated further against the item's components). */
const InteractionValueSchema = z.union([z.string().max(4000), z.array(ComponentId).max(4)]);
export const InteractionInputSchema = z.object({
  componentId: ComponentId,
  value: InteractionValueSchema.optional(),
  values: z.record(ComponentId, InteractionValueSchema).optional().refine(
    (v) => !v || Object.keys(v).length <= 8, 'at most 8 values'),
});
export type InteractionInput = z.input<typeof InteractionInputSchema>;

export const ListQuerySchema = z.object({
  state: z.enum(['active', 'resolved', 'removed', 'all']).default('active'),
  /** senderKey, e.g. `app:com.example.x`. */
  sender: z.string().max(300).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(400).optional(),
});
export type ListQuery = z.input<typeof ListQuerySchema>;

export const ClearFilterSchema = z.object({
  sender: z.string().max(300).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
}).default({});
export type ClearFilter = z.input<typeof ClearFilterSchema>;

const IDENTITY_FIELDS = ['caller', 'verification', 'attribution', 'senderKey', 'state', 'history', 'createdAt', 'id'];
const SENDER_IDENTITY_FIELDS = ['kind', 'id', 'attribution', 'nameAttribution'];

/**
 * Warnings for identity fields a client tried to set. They are stripped by
 * the schemas anyway — this only makes the attempt visible in the response.
 */
export function identityOverrideWarnings(raw: unknown): NotificationWarning[] {
  const out: NotificationWarning[] = [];
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const f of IDENTITY_FIELDS) {
    if (f in obj) out.push({ code: 'ignored-field', field: f, message: `'${f}' is set by the server and cannot be supplied` });
  }
  const sender = obj['sender'];
  if (sender && typeof sender === 'object') {
    for (const f of SENDER_IDENTITY_FIELDS) {
      if (f in (sender as Record<string, unknown>)) {
        out.push({ code: 'ignored-field', field: `sender.${f}`, message: `'sender.${f}' is derived from the authenticated caller` });
      }
    }
    const actor = (sender as Record<string, unknown>)['actor'];
    if (actor && typeof actor === 'object' && 'attribution' in (actor as Record<string, unknown>)) {
      out.push({ code: 'ignored-field', field: 'sender.actor.attribution', message: 'actor names are always declared/unverified' });
    }
  }
  return out;
}
