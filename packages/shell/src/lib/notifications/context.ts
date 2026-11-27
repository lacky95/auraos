/**
 * "Go to task": where a notification's target context leads. DOM-free —
 * the window functions are injected (the shell page defines them on
 * `window` in desktop-pages/index.astro).
 *
 *   activity     → reveal that Activity's window (else launch context.appId)
 *   instance     → reveal that instance's window (else launch context.appId)
 *   app          → launch / focus the app (context.appId ?? context.id)
 *   approval     → D102: Review, the shell's own owner dialog for that held
 *                  request (`window.auraOpenApproval`). Only on AuraOS's own
 *                  items (senderKey `auraos`), never on a locked screen's
 *                  view; core already drops the kind from any other sender.
 *   task, installation, custom → no target yet: no button, label only
 */
import type { Notification } from './api.ts';

type Context = NonNullable<Notification['context']>;

export interface WindowHost {
  /** Phase 4: where a window is (activity-linked "Go to activity"). */
  auraViewDetail?: (instanceId: string, activityId?: string) => import('./dialogs.ts').ViewDetail | null;
  auraRevealInstance?: (instanceId: string, activityId?: string) => unknown;
  auraHasWindow?: (instanceId: string, activityId?: string) => boolean;
  auraLaunchApp?: (appId: string) => unknown;
  /** D102: reopen a held approval in the owner dialog (lib/approvals/ownerDialog.ts). */
  auraOpenApproval?: (approvalId: string) => Promise<string>;
}

export interface ContextTarget {
  /** Whether a "Go to task" action exists. */
  actionable: boolean;
  /** Text shown next to / on the action. */
  label: string;
  /** The action button's text when it is not "Go to task" (D102: "Review"). */
  action?: string;
}

/** Where a notification's context comes from, for the kinds only AuraOS may use. */
export type ContextSource = Pick<Notification, 'senderKey'> & { lockscreen?: true; redacted?: true };

const KIND_LABEL: Record<string, string> = {
  activity: 'window', instance: 'app', app: 'app', task: 'task', installation: 'installation', custom: '',
};

export const APPROVAL_CONTEXT_LABEL = 'A request waiting for your decision';

export function contextTarget(ctx: Context | undefined | null, source?: ContextSource): ContextTarget | null {
  if (!ctx) return null;
  if (ctx.kind === 'approval') {
    const review = source?.senderKey === 'auraos' && !source.lockscreen && !source.redacted;
    return review ? { actionable: true, label: APPROVAL_CONTEXT_LABEL, action: 'Review' } : { actionable: false, label: APPROVAL_CONTEXT_LABEL };
  }
  const actionable = ctx.kind === 'activity' || ctx.kind === 'instance' || ctx.kind === 'app';
  const label = ctx.label?.trim() || (KIND_LABEL[ctx.kind] ? `${KIND_LABEL[ctx.kind]} ${ctx.appId ?? ctx.id}` : ctx.id);
  return { actionable, label };
}

/** Perform "Go to task". Returns what happened (for tests and status text). */
export async function goToContext(ctx: Context | undefined | null, host: WindowHost, source?: ContextSource): Promise<'revealed' | 'launched' | 'opened' | 'none'> {
  if (!ctx) return 'none';
  if (ctx.kind === 'approval') {
    if (!contextTarget(ctx, source)?.actionable || typeof host.auraOpenApproval !== 'function') return 'none';
    return (await host.auraOpenApproval(ctx.id)) === 'opened' ? 'opened' : 'none';
  }
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
