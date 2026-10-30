/**
 * One AuraOS-owned notification that is created once and then updated in
 * place — the setup card and the welcome checklist are both one of these.
 *
 *   • Every call is queued, so the create always lands before its updates.
 *   • The id is kept in `<dataDir>/aura/onboarding/<key>.id`, because the
 *     card outlives the shell process. The next boot either removes it
 *     (`cleanupStale` — a locked one can't even be dismissed) or keeps using
 *     it (`adoptStale`), which updates it in place: no second pop-up for a
 *     card the user has already seen.
 *   • An update with unchanged content is not sent — nothing for the shell
 *     to patch or pop up again.
 *   • Creation waits for the first shell tab (`whenClientConnected`): the
 *     shell only pops up notifications that arrive while a tab is listening,
 *     and boot runs on the very first request, before the desktop's script
 *     has connected.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';

type CreateInput = Parameters<ReturnType<typeof core.getNotificationService>['create']>[0];

/** Fields sent on create and on every update (`type` and the rest only on create). */
export interface CardContent {
  title: string;
  text: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  components?: unknown[];
}

const svc = () => core.getNotificationService();

// ─── First shell tab ─────────────────────────────────────────────────────

const CLIENT_KEY = Symbol.for('aura.onboarding.client');
type G = typeof globalThis & { [CLIENT_KEY]?: { seen: boolean; waiters: Array<() => void> } };
const clientGate = () => ((globalThis as G)[CLIENT_KEY] ??= { seen: false, waiters: [] });

/** Called by the middleware when a shell tab registers (`POST /api/os/clients`). */
export function noteClientConnected(): void {
  const g = clientGate();
  if (g.seen) return;
  g.seen = true;
  // Give the tab a moment to open its live event connection.
  setTimeout(() => { for (const w of g.waiters.splice(0)) w(); }, 2_000);
}

export function whenClientConnected(): Promise<void> {
  const g = clientGate();
  if (g.seen && !g.waiters.length) return Promise.resolve();
  return new Promise((res) => { g.waiters.push(res); });
}

// ─── The card ────────────────────────────────────────────────────────────

export class SystemCard {
  private id: string | null = null;
  /** JSON of the last content sent for `id`, to skip unchanged updates. */
  private lastSent: string | null = null;
  private removing = false;
  /** A create is queued (maybe still waiting for the first tab) or done. */
  private requested = false;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly idFile: string;
  private interactHandler: ((componentId: string) => void) | null = null;
  private removedHandler: (() => void) | null = null;

  constructor(private readonly key: string, dataDir: string, private readonly createFields: Omit<CreateInput, keyof CardContent>) {
    this.idFile = join(dataDir, 'aura', 'onboarding', `${key}.id`);
    core.OsEventBus.on('notification:interacted', (ev) => {
      if (!this.id || ev.id !== this.id || !this.interactHandler) return;
      const handler = this.interactHandler;
      void svc().get(ev.id).then((n) => {
        const cid = n?.lastInteraction?.componentId;
        if (cid) handler(cid);
      }).catch(() => undefined);
    });
    core.OsEventBus.on('notification:removed', (ev) => {
      // Not ours to report when we removed it ourselves.
      if (!this.id || ev.id !== this.id || this.removing) return;
      this.id = null;
      this.lastSent = null;
      this.requested = false;
      rmSync(this.idFile, { force: true });
      this.removedHandler?.();
    });
  }

  get shown(): boolean { return this.id !== null; }
  /**
   * `shown`, or a `show()` is queued that will create it — e.g. boot ran on a
   * headless request and the create still waits for the first shell tab.
   * Callers that decide "nothing was ever shown, skip the final update" must
   * check this, or the queued create lands later with stale content.
   */
  get pending(): boolean { return this.requested || this.id !== null; }

  onInteract(fn: (componentId: string) => void): void { this.interactHandler = fn; }
  /** The user dismissed it (or it expired) — not called for `remove()`. */
  onRemoved(fn: () => void): void { this.removedHandler = fn; }

  private queue<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const run = this.chain.then(fn).catch((err: unknown) => {
      console.warn(`[onboarding] ${this.key} card: ${(err as Error).message}`);
      return undefined;
    });
    this.chain = run;
    return run;
  }

  /** Remove a card a previous shell left behind. */
  cleanupStale(): void {
    if (!existsSync(this.idFile)) return;
    const stale = readFileSync(this.idFile, 'utf-8').trim();
    rmSync(this.idFile, { force: true });
    if (stale) void this.queue(() => svc().removeBySender(stale, core.SYSTEM_CALLER));
  }

  /**
   * Keep using the card a previous shell left behind, when it is still
   * active; otherwise forget it. Queued, so a following `show()` updates it.
   */
  adoptStale(): Promise<unknown> {
    return this.queue(async () => {
      if (!existsSync(this.idFile)) return;
      const stale = readFileSync(this.idFile, 'utf-8').trim();
      const n = stale ? await svc().get(stale).catch(() => null) : null;
      if (n && n.state === 'active') { this.id = stale; return; }
      rmSync(this.idFile, { force: true });
    });
  }

  /** Create (after the first shell tab) or update in place. */
  show(content: CardContent): Promise<unknown> {
    this.requested = true;
    return this.queue(async () => {
      const json = JSON.stringify(content);
      if (this.id && json === this.lastSent) return;
      if (this.id) {
        try {
          await svc().update(this.id, { ...content }, core.SYSTEM_CALLER);
          this.lastSent = json;
          return;
        } catch (err) {
          // Gone (dismissed, expired, force-removed): fall through and recreate.
          console.warn(`[onboarding] ${this.key} card update failed, recreating: ${(err as Error).message}`);
          this.id = null;
        }
      }
      await whenClientConnected();
      const r = await svc().create({ ...this.createFields, ...content } as CreateInput, core.SYSTEM_CALLER);
      this.id = r.notification.id;
      this.lastSent = json;
      try { mkdirSync(join(this.idFile, '..'), { recursive: true }); writeFileSync(this.idFile, this.id); } catch { /* best effort */ }
    });
  }

  remove(afterMs = 0): void {
    const go = () => void this.queue(async () => {
      if (!this.id) return;
      const id = this.id;
      this.removing = true;
      try { await svc().removeBySender(id, core.SYSTEM_CALLER); }
      finally {
        this.removing = false;
        this.id = null;
        this.lastSent = null;
        this.requested = false;
        rmSync(this.idFile, { force: true });
      }
    });
    if (afterMs > 0) setTimeout(go, afterMs); else go();
  }
}
