/**
 * Onboarding content and rendering — pure, no I/O, unit-tested in
 * test/onboarding.test.ts. The runtime halves (setupCard.ts, welcome.ts) feed
 * step states in and send what these functions return as notifications.
 */

// ─── Setup card ──────────────────────────────────────────────────────────

export type SetupStepId = 'image' | 'sdk' | 'docs' | 'speech';
export type SetupStatus = 'pending' | 'running' | 'done' | 'failed' | 'warn';

export interface SetupStep {
  id: SetupStepId;
  label: string;
  status: SetupStatus;
  /** One line under the label: current build step, error, hint. */
  detail?: string;
  /** 0..1 within this step (the image build reports Step N/M). */
  progress?: number | null;
  /** A failure here doesn't hold up "AuraOS is ready". */
  optional?: boolean;
}

export const SETUP_LABELS: Record<SetupStepId, string> = {
  image:  'App image',
  sdk:    'App registry and SDK',
  docs:   'Aura Docs',
  speech: 'Speech model',
};

const MARK: Record<SetupStatus, string> = {
  pending: '⬜', running: '⏳', done: '✅', failed: '❌', warn: '⚠️',
};

/** Finished for the purpose of "is AuraOS ready". */
export function isSettled(s: SetupStep): boolean {
  return s.status === 'done' || s.status === 'warn' || (s.optional === true && s.status === 'failed');
}

/** Overall 0..1: settled steps count 1, a running step its own fraction. */
export function setupProgress(steps: SetupStep[]): number | null {
  if (!steps.length) return null;
  let sum = 0;
  for (const s of steps) {
    if (isSettled(s)) sum += 1;
    else if (s.status === 'running' && typeof s.progress === 'number') sum += Math.min(Math.max(s.progress, 0), 1);
  }
  return sum / steps.length;
}

/** A required step failed — the card turns into the error view. */
export function failedSteps(steps: SetupStep[]): SetupStep[] {
  return steps.filter((s) => s.status === 'failed' && !s.optional);
}

const oneLine = (s: string, max = 160) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function renderSetupChecklist(steps: SetupStep[]): string {
  return steps.map((s) => {
    const detail = s.detail ? ` — ${oneLine(s.detail)}` : '';
    return `- ${MARK[s.status]} **${s.label}**${detail}`;
  }).join('\n');
}

// ─── Welcome checklist ──────────────────────────────────────────────────

export type WelcomeStepId = 'admin' | 'agent' | 'login' | 'theme' | 'firstApp' | 'docs';
export type WelcomeTarget = 'terminal' | 'settings' | 'docs';

export interface WelcomeStep {
  id: WelcomeStepId;
  title: string;
  /** Markdown: what to do, with the command where there is one. */
  how: string;
  target: WelcomeTarget;
}

export const WELCOME_STEPS: WelcomeStep[] = [
  {
    id: 'admin', target: 'settings', title: 'Unlock admin',
    how: 'Settings → Notifications & access → Unlock admin. The credential is in the master container: in the Terminal run `aura jump -m`, then `aura admin credential`.',
  },
  {
    id: 'agent', target: 'terminal', title: 'Install an AI agent',
    how: 'In the Terminal: `aura cap install claude` (or `codex`).',
  },
  {
    id: 'login', target: 'terminal', title: 'Log in to your agent',
    how: 'Run `claude` (or `codex`) in the Terminal and sign in. The login follows you into every app.',
  },
  {
    id: 'theme', target: 'settings', title: 'Pick a theme',
    how: 'Settings → Theme.',
  },
  {
    id: 'firstApp', target: 'terminal', title: 'Build your first app',
    how: 'In the Terminal: `aura dev new`.',
  },
  {
    id: 'docs', target: 'docs', title: 'Read the docs',
    how: 'Aura Docs explains apps, sidecars, mounts and the `aura` CLI.',
  },
];

export const TARGET_APP: Record<WelcomeTarget, string> = {
  terminal: 'com.aura.terminal',
  settings: 'com.aura.settings',
  docs:     'com.aura.docs',
};

const TARGET_LABEL: Record<WelcomeTarget, string> = {
  terminal: 'Open Terminal',
  settings: 'Open Settings',
  docs:     'Open Docs',
};

export const HIDE_BUTTON_ID = 'hide';
/** Button id for a target: `open-terminal`, `open-settings`, `open-docs`. */
export const openButtonId = (t: WelcomeTarget) => `open-${t}`;

/** The app a button id opens, or null (Hide, unknown ids). */
export function appForButton(componentId: string | undefined): string | null {
  if (!componentId?.startsWith('open-')) return null;
  const t = componentId.slice(5) as WelcomeTarget;
  return TARGET_APP[t] ?? null;
}

export interface WelcomeView {
  title: string;
  text: string;
  allDone: boolean;
  components: Array<
    | { kind: 'markdown'; id: string; text: string }
    | { kind: 'button'; id: string; label: string; variant: 'primary' | 'secondary' | 'tertiary' }
  >;
}

/**
 * The welcome card for a set of done steps. `available` limits the buttons to
 * apps that are installed and enabled (a step whose app is missing still shows
 * its how-to, just without a button).
 */
export function renderWelcome(done: ReadonlySet<WelcomeStepId>, available: ReadonlySet<WelcomeTarget>): WelcomeView {
  const open = WELCOME_STEPS.filter((s) => !done.has(s.id));
  const count = WELCOME_STEPS.length - open.length;
  if (!open.length) {
    return {
      title: "You're all set",
      text: 'Every getting-started step is done. Have fun with AuraOS!',
      allDone: true,
      components: [],
    };
  }
  const list = WELCOME_STEPS.map((s) => (done.has(s.id)
    ? `- [x] ~~${s.title}~~`
    : `- [ ] **${s.title}** — ${s.how}`)).join('\n');
  // One button per distinct target still needed, in checklist order.
  const targets: WelcomeTarget[] = [];
  for (const s of open) if (available.has(s.target) && !targets.includes(s.target)) targets.push(s.target);
  return {
    title: 'Welcome to AuraOS',
    text: `Getting started: ${count} of ${WELCOME_STEPS.length} done. Steps tick off by themselves.`,
    allDone: false,
    components: [
      { kind: 'markdown', id: 'steps', text: list },
      ...targets.map((t, i) => ({
        kind: 'button' as const, id: openButtonId(t), label: TARGET_LABEL[t],
        variant: (i === 0 ? 'primary' : 'secondary') as 'primary' | 'secondary',
      })),
      { kind: 'button', id: HIDE_BUTTON_ID, label: 'Hide checklist', variant: 'tertiary' },
    ],
  };
}
