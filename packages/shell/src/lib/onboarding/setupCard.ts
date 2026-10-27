/**
 * The "Setting up AuraOS" card — what the shell does in the background on a
 * first boot, step by step, with Retry when a step fails.
 *
 *   App image             aura-base (core BaseImage). Compose normally built
 *                         it already, then this is done at once.
 *   App registry and SDK  com.aura.registry up + @aura/* published
 *                         (lib/sdkBootstrap.ts).
 *   Aura Docs             com.aura.docs running (autoStart).
 *   Speech model          com.aura.whisper's speech container answering —
 *                         it downloads ~500 MB on a first start. Optional:
 *                         a slow download never holds up "ready".
 *
 * On a first boot (no `os/onboarding.setupDoneAt`) all four are tracked and
 * the card shows from the first shell tab on. When everything is settled it
 * says "AuraOS is ready", records `setupDoneAt` and hands over to the welcome
 * checklist. Later boots track only the app image and show the card only
 * while it has to be (re)built — the safety net from baseImageBootstrap.
 *
 * Status and the image build log: GET /api/admin/first-boot (`?log=1`).
 */

// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { ensureSdkPublished, type SdkPhase } from '../sdkBootstrap.js';
import { SystemCard } from './card.js';
import {
  SETUP_LABELS, failedSteps, isSettled, renderSetupChecklist, setupProgress,
  type SetupStep, type SetupStepId,
} from './steps.js';

const DOCS_APP = 'com.aura.docs';
const SPEECH_APP = 'com.aura.whisper';
const RETRY_ID = 'retry';
const RENDER_EVERY_MS = 1_000;
const READY_LINGER_MS = 6_000;
const SPEECH_POLL_MS = 10_000;
const SPEECH_MAX_MS = 20 * 60_000;
const IMAGE_LOG_LINES = 30;

export interface SetupCardOpts {
  dataDir: string;
  shellPort: number;
  /** True on a first boot: track every step. False: the app image only. */
  firstBoot: boolean;
  /** Called once when a first-boot setup has finished. */
  onReady: () => void;
}

export class SetupCard {
  private readonly steps = new Map<SetupStepId, SetupStep>();
  private readonly card: SystemCard;
  private readonly base: ReturnType<typeof core.getBaseImage>;
  private lastRender = 0;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private finished = false;
  /** First boot: the later steps only exist after afterInit() — not "ready" before. */
  private tracking: boolean;

  constructor(private readonly opts: SetupCardOpts) {
    this.tracking = !opts.firstBoot;
    this.card = new SystemCard('setup', opts.dataDir, {
      type: 'locked',
      pinned: true,
      visibility: 'public',
      context: { kind: 'installation', id: 'auraos-setup', label: 'AuraOS setup' },
    });
    this.card.cleanupStale();
    this.card.onInteract((cid) => { if (cid === RETRY_ID) this.retry(); });
    this.base = core.getBaseImage({ dataDir: opts.dataDir });
  }

  /** Boot: before AppManager.init() — the app image gates container spawns. */
  start(): void {
    this.set('image', { status: 'running', detail: 'checking' });
    this.base.onChange((s) => this.onImage(s));
    void this.base.ensure().catch(() => undefined);
  }

  /** After AppManager.init(): registry/SDK, docs and speech (first boot only). */
  afterInit(): void {
    if (this.opts.firstBoot) {
      this.trackSdk();
      this.trackDocs();
      this.trackSpeech();
      this.tracking = true;
      this.scheduleRender();
    } else {
      // Not a first boot: the SDK seed still runs every boot, quietly.
      void ensureSdkPublished();
    }
  }

  // ─── Steps ─────────────────────────────────────────────────────────────

  private set(id: SetupStepId, patch: Partial<SetupStep>): void {
    const cur = this.steps.get(id) ?? { id, label: SETUP_LABELS[id], status: 'pending' as const };
    this.steps.set(id, { ...cur, ...patch });
    this.scheduleRender();
  }

  private onImage(s: import('@aura/core').BaseImageState): void {
    if (s.phase === 'building') this.set('image', { status: 'running', progress: s.progress, detail: s.step ?? 'preparing the build' });
    else if (s.phase === 'ready') this.set('image', { status: 'done', progress: 1, detail: s.built ? 'built' : undefined });
    else if (s.phase === 'failed') this.set('image', { status: 'failed', detail: s.error ?? 'the build failed' });
  }

  private trackSdk(): void {
    const label: Record<SdkPhase, SetupStep['status']> = {
      waiting: 'running', publishing: 'running', done: 'done', failed: 'failed', skipped: 'warn',
    };
    this.set('sdk', { status: 'pending' });
    void ensureSdkPublished((phase, detail) => this.set('sdk', { status: label[phase], detail }));
  }

  private trackDocs(): void {
    const mgr = core.getAppManager();
    if (!mgr.registry.has(DOCS_APP) || !mgr.isEnabled(DOCS_APP)) return;
    const running = () => mgr.getInstancesByApp(DOCS_APP).some((i) => i.state === 'resumed');
    this.set('docs', running() ? { status: 'done' } : { status: 'running', detail: 'starting' });
    core.OsEventBus.on('app:stateChanged', (ev) => {
      if (ev.appId !== DOCS_APP) return;
      if (ev.state === 'resumed') this.set('docs', { status: 'done', detail: undefined });
      else if (ev.state === 'error') this.set('docs', { status: 'failed', detail: 'the app failed to start — see the Process Manager' });
    });
    core.OsEventBus.on('app:crashed', (ev) => {
      if (ev.appId === DOCS_APP && this.steps.get('docs')?.status !== 'done') this.set('docs', { status: 'failed', detail: ev.error });
    });
  }

  private trackSpeech(): void {
    const mgr = core.getAppManager();
    if (!mgr.registry.has(SPEECH_APP) || !mgr.isEnabled(SPEECH_APP)) return;
    this.set('speech', { status: 'running', optional: true, detail: 'downloading the speech model (~500 MB)' });
    const deadline = Date.now() + SPEECH_MAX_MS;
    const url = `http://127.0.0.1:${this.opts.shellPort}/api/proxy/${SPEECH_APP}/api/status`;
    const poll = async () => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        const body = await r.json() as { whisper?: { http?: { ok?: boolean } } };
        if (body.whisper?.http?.ok) { this.set('speech', { status: 'done', detail: undefined }); return; }
      } catch { /* not up yet */ }
      if (Date.now() > deadline) {
        this.set('speech', { status: 'warn', detail: 'still downloading — it finishes in the background' });
        return;
      }
      setTimeout(() => { void poll(); }, SPEECH_POLL_MS);
    };
    void poll();
  }

  private retry(): void {
    for (const s of failedSteps([...this.steps.values()])) {
      console.log(`[onboarding] retrying setup step ${s.id}`);
      if (s.id === 'image') void this.base.ensure().catch(() => undefined);
      else if (s.id === 'sdk') this.trackSdk();
      else if (s.id === 'docs') {
        this.set('docs', { status: 'running', detail: 'starting' });
        core.getAppManager().start(DOCS_APP).catch((err: unknown) => {
          this.set('docs', { status: 'failed', detail: (err as Error).message });
        });
      }
    }
  }

  // ─── Rendering ─────────────────────────────────────────────────────────

  private scheduleRender(): void {
    const wait = RENDER_EVERY_MS - (Date.now() - this.lastRender);
    if (wait <= 0) { this.render(); return; }
    if (!this.renderTimer) this.renderTimer = setTimeout(() => { this.renderTimer = null; this.render(); }, wait);
  }

  private imageLogTail(): string {
    const lines = (this.base.readLog() ?? '').trimEnd().split('\n');
    return lines.slice(-IMAGE_LOG_LINES).join('\n').replace(/```/g, "'''");
  }

  private render(): void {
    this.lastRender = Date.now();
    const steps = [...this.steps.values()];
    const failed = failedSteps(steps);
    const allSettled = this.tracking && steps.length > 0 && steps.every(isSettled);
    const image = this.steps.get('image');

    // Not a first boot: only show while the image is being (re)built or broken.
    if (!this.opts.firstBoot && !this.card.shown && image?.status !== 'running' && image?.status !== 'failed') return;
    if (!this.opts.firstBoot && !this.card.shown && image?.status === 'running' && image.detail === 'checking') return;

    if (failed.length) {
      const components: unknown[] = [{ kind: 'markdown', id: 'steps', text: renderSetupChecklist(steps) }];
      if (failed.some((s) => s.id === 'image')) {
        components.push({ kind: 'markdown', id: 'log', label: 'Last lines of the image build', text: '```\n' + this.imageLogTail() + '\n```', maxHeight: 320 });
      }
      components.push({ kind: 'button', id: RETRY_ID, label: 'Retry', variant: 'primary' });
      void this.card.show({
        title: 'AuraOS setup needs attention',
        text: `${failed.map((s) => s.label).join(', ')} failed. Retry, or see the shell log (\`docker logs aura-shell\`). Image build log: /api/admin/first-boot?log=1`,
        priority: 'urgent',
        components,
      });
      return;
    }

    if (allSettled) {
      if (this.finished) return;
      this.finished = true;
      if (!this.card.shown) { this.done(); return; } // nothing was ever shown
      void this.card.show({
        title: 'AuraOS is ready',
        text: 'Setup is finished.',
        priority: 'medium',
        components: [
          { kind: 'markdown', id: 'steps', text: renderSetupChecklist(steps) },
          { kind: 'progress', id: 'progress', value: 1, label: 'Done' },
        ],
      });
      this.card.remove(READY_LINGER_MS);
      this.done();
      return;
    }

    this.finished = false;
    void this.card.show({
      title: 'Setting up AuraOS',
      text: this.opts.firstBoot
        ? 'AuraOS is getting ready in the background. You can already look around; apps start as soon as what they need is there.'
        : 'AuraOS is rebuilding the image every app container runs from. Apps start when it is ready.',
      priority: 'high',
      components: [
        { kind: 'markdown', id: 'steps', text: renderSetupChecklist(steps) },
        { kind: 'progress', id: 'progress', value: setupProgress(steps), label: steps.find((s) => s.status === 'running')?.label ?? 'Starting' },
      ],
    });
  }

  private done(): void {
    if (this.opts.firstBoot) this.opts.onReady();
  }
}
