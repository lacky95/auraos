/**
 * The "Welcome to AuraOS" checklist — a pinned card with the getting-started
 * steps (steps.ts). Each open step has a button that opens the right app
 * (through the shell UI command broker, so nothing in the notification
 * schema had to change), and steps tick themselves off:
 *
 *   admin     an admin unlock succeeded (pages/api/admin/session.ts marks it)
 *   agent     claude or codex is in the app toolchain
 *   login     a Claude / Codex login exists in the shared home
 *   theme     os/theme differs from the seeded default
 *   firstApp  an app is installed in the user scope
 *   docs      Aura Docs was opened
 *
 * Done steps are recorded in `os/onboarding` (state.ts) and stay done. The
 * card goes away when everything is done, or for good when the user hides or
 * dismisses it.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { defaultKv } from '@aura/kv-store';
import { uiCommandBroker } from '../uiCommandBroker.js';
import { SystemCard } from './card.js';
import { readOnboarding, updateOnboarding, type OnboardingState } from './state.js';
import {
  HIDE_BUTTON_ID, TARGET_APP, WELCOME_STEPS, appForButton, renderWelcome,
  type WelcomeStepId, type WelcomeTarget,
} from './steps.js';

const RECHECK_MS = 60_000;
const ALL_DONE_LINGER_MS = 10_000;

export interface WelcomeOpts {
  dataDir: string;
  toolchainDir: string;
}

/** Detect which steps are done right now (beyond what is already recorded). */
export function detectDone(opts: WelcomeOpts, theme: unknown): Set<WelcomeStepId> {
  const done = new Set<WelcomeStepId>();
  const bin = join(opts.toolchainDir, 'bin');
  if (existsSync(join(bin, 'claude')) || existsSync(join(bin, 'codex'))) done.add('agent');
  const home = join(opts.dataDir, 'aura', 'home', 'default');
  if (existsSync(join(home, '.claude', '.credentials.json')) || existsSync(join(home, '.codex', 'auth.json'))) done.add('login');
  const t = (theme ?? {}) as { themeIdDark?: string; themeIdLight?: string; colorMode?: string };
  const tm = core.ThemeManager;
  if (theme && (t.themeIdDark !== tm.DEFAULT_THEME_ID_DARK || t.themeIdLight !== tm.DEFAULT_THEME_ID_LIGHT || t.colorMode !== tm.DEFAULT_COLOR_MODE)) {
    done.add('theme');
  }
  try {
    if (core.getAppManager().registry.getAll().some((m) => m.scopeId === 'user')) done.add('firstApp');
  } catch { /* AppManager not up yet */ }
  return done;
}

const KEY = Symbol.for('aura.onboarding.welcome');
type G = typeof globalThis & { [KEY]?: Welcome };

/** The running checklist, so routes can mark steps (admin unlock). */
export function currentWelcome(): Welcome | undefined {
  return (globalThis as G)[KEY];
}

export class Welcome {
  private readonly card: SystemCard;
  private state: OnboardingState | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private closing = false;
  private checking: Promise<void> | null = null;

  constructor(private readonly opts: WelcomeOpts) {
    this.card = new SystemCard('welcome', opts.dataDir, {
      type: 'simple',
      pinned: true,
      visibility: 'public',
      context: { kind: 'task', id: 'onboarding', label: 'Getting started' },
    });
    this.card.cleanupStale();
    this.card.onInteract((cid) => this.onButton(cid));
    this.card.onRemoved(() => {
      if (this.closing) return;
      console.log('[onboarding] welcome checklist dismissed — not showing it again');
      void this.hide();
    });
    (globalThis as G)[KEY] = this;

    core.OsEventBus.on('app:mruChanged', (ev) => { if (ev.appId === TARGET_APP.docs) void this.markDone('docs'); });
    core.OsEventBus.on('app:installed', () => { void this.check(); });
    core.OsEventBus.on('kv:changed', (ev) => { if (ev.namespace === 'os' && ev.key === 'theme') void this.check(); });
  }

  /** Show the checklist unless it is hidden or complete. Idempotent. */
  async start(): Promise<void> {
    this.state = await readOnboarding();
    if (!this.state || this.state.welcome.hidden) return;
    if (WELCOME_STEPS.every((s) => this.state!.welcome.done[s.id])) return;
    if (this.running) { await this.check(); return; }
    this.running = true;
    this.timer = setInterval(() => { void this.check(); }, RECHECK_MS);
    await this.check();
  }

  /** Record a step as done (from a route or an event) and refresh the card. */
  async markDone(id: WelcomeStepId): Promise<void> {
    const s = await updateOnboarding((cur) => (cur.welcome.done[id]
      ? cur
      : { ...cur, welcome: { ...cur.welcome, done: { ...cur.welcome.done, [id]: Date.now() } } }));
    this.state = s;
    if (this.running) this.render();
  }

  private check(): Promise<void> {
    if (!this.running) return Promise.resolve();
    // Coalesce bursts (theme save + interval + install at once).
    this.checking ??= (async () => {
      try {
        const kv = defaultKv();
        let theme: unknown = null;
        try { theme = await kv.getValue('os', 'theme'); } finally { await kv.close().catch(() => undefined); }
        const found = detectDone(this.opts, theme);
        const known = this.state?.welcome.done ?? {};
        const fresh = [...found].filter((id) => !known[id]);
        if (fresh.length) {
          const now = Date.now();
          this.state = await updateOnboarding((cur) => {
            const done = { ...cur.welcome.done };
            for (const id of fresh) done[id] ??= now;
            return { ...cur, welcome: { ...cur.welcome, done } };
          });
        }
        this.render();
      } catch (err) {
        console.warn(`[onboarding] welcome check failed: ${(err as Error).message}`);
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }

  private available(): Set<WelcomeTarget> {
    const out = new Set<WelcomeTarget>();
    try {
      const mgr = core.getAppManager();
      for (const [t, appId] of Object.entries(TARGET_APP) as Array<[WelcomeTarget, string]>) {
        if (mgr.registry.has(appId) && mgr.isEnabled(appId)) out.add(t);
      }
    } catch { /* AppManager not up yet */ }
    return out;
  }

  private render(): void {
    if (!this.running || !this.state || this.state.welcome.hidden) return;
    const done = new Set(Object.keys(this.state.welcome.done) as WelcomeStepId[]);
    const view = renderWelcome(done, this.available());
    void this.card.show({ title: view.title, text: view.text, priority: 'medium', components: view.components });
    if (view.allDone) this.stop(ALL_DONE_LINGER_MS);
  }

  private onButton(componentId: string): void {
    if (componentId === HIDE_BUTTON_ID) { void this.hide(); return; }
    const appId = appForButton(componentId);
    if (!appId) return;
    void uiCommandBroker.dispatch('launchApp', { appId }).then((r) => {
      if (!r.ok) console.warn(`[onboarding] could not open ${appId}: ${r.message}`);
    });
  }

  private async hide(): Promise<void> {
    this.state = await updateOnboarding((cur) => ({ ...cur, welcome: { ...cur.welcome, hidden: true } }));
    this.stop(0);
  }

  private stop(afterMs: number): void {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.closing = true;
    this.card.remove(afterMs);
    setTimeout(() => { this.closing = false; }, afterMs + 5_000);
  }
}
