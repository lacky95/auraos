/**
 * Smart "Clear all" (phase 4) — DOM-free grouping of the active list.
 *
 * Every item is in exactly ONE group, checked in this order:
 *   locked     type locked — never bulk-cleared (⋯ → Force remove)
 *   pinned     pinned — "keep this": not in Clear all, own entry only
 *   decisions  AuraOS desktop decisions — never bulk-cleared (answer them)
 *   questions  dialogues, or items with inputs / options — dismissing tells
 *              the sender (`dismissed`)
 *   urgent     priority urgent / high
 *   info       everything else
 *
 * Clear all: only info to clear → clear it at once (no menu). Otherwise a
 * menu with one entry per non-empty group plus "Clear all (except locked,
 * pinned and decisions)". Questions / urgent need a confirm.
 */
import type { Notification } from './api.ts';
import { hasFormFields, isDesktopDecision } from './dialogs.ts';

export type ClearGroupId = 'locked' | 'pinned' | 'decisions' | 'questions' | 'urgent' | 'info';
export const GROUP_ORDER: readonly ClearGroupId[] = ['questions', 'urgent', 'info', 'pinned', 'decisions', 'locked'];
/** Never cleared in bulk. */
export const NEVER_BULK: readonly ClearGroupId[] = ['locked', 'decisions'];
/** What "Clear all (except locked, pinned and decisions)" covers. */
export const CLEAR_ALL_EXCEPT: readonly ClearGroupId[] = ['questions', 'urgent', 'info'];

export const GROUP_LABEL: Record<ClearGroupId, string> = {
  locked: 'Locked', pinned: 'Pinned', decisions: 'Decisions', questions: 'Questions', urgent: 'Urgent & high', info: 'Info',
};

export function groupOf(n: Notification): ClearGroupId {
  if (n.type === 'locked') return 'locked';
  if (n.pinned) return 'pinned';
  if (isDesktopDecision(n)) return 'decisions';
  if (n.type === 'dialogue' || hasFormFields(n)) return 'questions';
  if (n.priority === 'urgent' || n.priority === 'high') return 'urgent';
  return 'info';
}

export type Groups = Record<ClearGroupId, Notification[]>;

export function groupItems(items: readonly Notification[]): Groups {
  const g: Groups = { locked: [], pinned: [], decisions: [], questions: [], urgent: [], info: [] };
  for (const n of items) if (n.state === 'active') g[groupOf(n)].push(n);
  return g;
}

export type ClearPlan =
  | { kind: 'nothing' }
  | { kind: 'fast'; ids: string[] }   // only info to clear: no menu
  | { kind: 'menu' };

export function clearPlan(g: Groups): ClearPlan {
  if (!g.questions.length && !g.urgent.length) {
    if (g.info.length) return { kind: 'fast', ids: g.info.map((n) => n.id) };
    return g.pinned.length ? { kind: 'menu' } : { kind: 'nothing' };
  }
  return { kind: 'menu' };
}

/** Ids a menu entry clears ('all' = every clearable group except pinned). */
export function idsFor(g: Groups, entry: ClearGroupId | 'all'): string[] {
  if (entry === 'all') return CLEAR_ALL_EXCEPT.flatMap((k) => g[k].map((n) => n.id));
  if (NEVER_BULK.includes(entry)) return [];
  return g[entry].map((n) => n.id);
}

/** Confirm text when the entry dismisses questions or urgent items, else null. */
export function confirmFor(g: Groups, entry: ClearGroupId | 'all'): string | null {
  const q = entry === 'all' || entry === 'questions' ? g.questions.length : 0;
  const u = entry === 'all' || entry === 'urgent' ? g.urgent.length : 0;
  if (!q && !u) return null;
  const s = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (entry === 'questions') return `Dismiss ${s(q, 'open question', 'open questions')}? Senders will be told.`;
  if (entry === 'urgent') return `Dismiss ${s(u, 'urgent / high notification', 'urgent / high notifications')}?`;
  const parts = [q ? s(q, 'open question', 'open questions') : '', u ? s(u, 'urgent / high', 'urgent / high') : ''].filter(Boolean).join(' and ');
  return `Clear ${idsFor(g, 'all').length}, including ${parts}?${q ? ' Senders will be told.' : ''}`;
}

/** "Cleared 7 · kept 2 locked, 1 pinned" (`failed` when some could not be cleared). */
export function resultText(cleared: number, g: Groups, failed = 0): string {
  const kept = (['locked', 'pinned', 'decisions'] as const)
    .filter((k) => g[k].length)
    .map((k) => `${g[k].length} ${k === 'decisions' ? (g[k].length === 1 ? 'decision' : 'decisions') : k}`);
  return `Cleared ${cleared}${failed ? ` · ${failed} failed` : ''}${kept.length ? ` · kept ${kept.join(', ')}` : ''}`;
}

/** Run `fn` over `ids` in small parallel batches. */
export async function inBatches<T>(ids: readonly string[], size: number, fn: (id: string) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...await Promise.all(ids.slice(i, i + size).map(fn)));
  return out;
}
