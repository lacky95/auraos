/**
 * "Go to task": where a notification's target context leads. DOM-free —
 * the window functions are injected (the shell page defines them on
 * `window` in pages/index.astro).
 *
 *   activity     → reveal that Activity's window (else launch context.appId)
 *   instance     → reveal that instance's window (else launch context.appId)
 *   app          → launch / focus the app (context.appId ?? context.id)
 *   task, installation, custom → no target yet: no button, label only
 */
import type { Notification } from './api.ts';

type Context = NonNullable<Notification['context']>;

export interface WindowHost {
  auraRevealInstance?: (instanceId: string, activityId?: string) => unknown;
  auraHasWindow?: (instanceId: string, activityId?: string) => boolean;
  auraLaunchApp?: (appId: string) => unknown;
}

export interface ContextTarget {
  /** Whether a "Go to task" action exists. */
  actionable: boolean;
  /** Text shown next to / on the action. */
  label: string;
}

const KIND_LABEL: Record<string, string> = {
  activity: 'window', instance: 'app', app: 'app', task: 'task', installation: 'installation', custom: '',
};

export function contextTarget(ctx: Context | undefined | null): ContextTarget | null {
  if (!ctx) return null;
  const actionable = ctx.kind === 'activity' || ctx.kind === 'instance' || ctx.kind === 'app';
  const label = ctx.label?.trim() || (KIND_LABEL[ctx.kind] ? `${KIND_LABEL[ctx.kind]} ${ctx.appId ?? ctx.id}` : ctx.id);
  return { actionable, label };
}

/** Perform "Go to task". Returns what happened (for tests and status text). */
export async function goToContext(ctx: Context | undefined | null, host: WindowHost): Promise<'revealed' | 'launched' | 'none'> {
  if (!ctx) return 'none';
  const launch = async (appId: string | undefined) => {
    if (!appId || typeof host.auraLaunchApp !== 'function') return 'none' as const;
    await host.auraLaunchApp(appId);
    return 'launched' as const;
  };
  switch (ctx.kind) {
    case 'activity': {
      if (host.auraHasWindow?.('', ctx.id) && host.auraRevealInstance) {
        await host.auraRevealInstance('', ctx.id);
        return 'revealed';
      }
      return launch(ctx.appId);
    }
    case 'instance': {
      if (host.auraHasWindow?.(ctx.id) && host.auraRevealInstance) {
        await host.auraRevealInstance(ctx.id);
        return 'revealed';
      }
      return launch(ctx.appId);
    }
    case 'app':
      return launch(ctx.appId ?? ctx.id);
    default:
      return 'none';
  }
}
