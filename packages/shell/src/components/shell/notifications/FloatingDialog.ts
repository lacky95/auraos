/**
 * FloatingDialog — a non-modal dialogue over the desktop (phase 4), for
 * senders without a window of their own (background apps, agents) or whose
 * context is not their window, and every dialogue on the phone.
 *
 *   panel  desktop: right-aligned to the 'notifications' anchor, above the
 *          Dock, z-index 1080 (above the list 1060 and pop-ups 1070). It
 *          never blocks other windows.
 *   sheet  phone: a nearly full-width bottom sheet above the Dock / keyboard.
 *   full   phone, complex content (> 3 fields or a multiline input): a
 *          dedicated full view (z-index 1085).
 *
 * "Later" / Escape hide it (it stays in the list) — except when it stands in
 * for a blocking window dialogue on the phone (`blockSlot`), where that
 * window stays covered + inert behind it until it is answered.
 */
import type { Notification } from '../../../lib/notifications/api.ts';
import type { DialogLayout, MountedDialog } from '../../../lib/notifications/dialogs.ts';
import type { AppLookup } from '../../../lib/notifications/format.ts';
import type { CardActions } from './NotificationCard.ts';
import { buildDialogFrame, focusFirst, playExit } from './DialogFrame.ts';
import { coverWindow } from './WindowDialog.ts';
import { watchPlacement } from './placement.ts';

const STACK_ID = 'aura-dlg-float';

/** The shared stack for panels / sheets (body root). */
function stack(): HTMLElement {
  let s = document.getElementById(STACK_ID);
  if (!s) {
    s = document.createElement('div');
    s.id = STACK_ID;
    s.className = 'aura-dlg-float';
    document.body.appendChild(s);
    const stop = watchPlacement((p) => {
      if (!s!.isConnected) { stop(); return; }
      s!.dataset['layout'] = p.phone ? 'phone' : 'desktop';
      s!.style.setProperty('--dlg-right', `${p.right}px`);
      s!.style.setProperty('--dlg-keyboard', `${p.keyboard}px`);
    });
    (s as HTMLElement & { __stop?: () => void }).__stop = stop;
  }
  return s;
}

function releaseStack(): void {
  const s = document.getElementById(STACK_ID) as (HTMLElement & { __stop?: () => void }) | null;
  if (s && !s.childElementCount) { s.__stop?.(); s.remove(); }
}

export interface FloatingDialogOptions {
  layout: DialogLayout;
  takeFocus: boolean;
  actions: CardActions;
  appLookup?: AppLookup;
  onLater: () => void;
  /** Phone stand-in for a blocking window dialogue: cover + inert that slot. */
  blockSlot?: HTMLElement | null;
}

export function mountFloatingDialog(n: Notification, opts: FloatingDialogOptions): MountedDialog {
  const blocking = !!opts.blockSlot;
  const frame = buildDialogFrame(n, {
    actions: opts.actions,
    ...(opts.appLookup ? { appLookup: opts.appLookup } : {}),
    takeFocus: opts.takeFocus,
    modal: opts.layout === 'full' || blocking,
    ...(blocking ? {} : { onLater: opts.onLater }),
    kicker: blocking ? 'Answer to continue' : 'Question',
  });
  frame.root.classList.add('aura-dlg-floating');
  frame.root.dataset['layout'] = opts.layout;
  if (opts.layout === 'full') {
    frame.root.classList.add('aura-dlg-full');
    document.body.appendChild(frame.root);
  } else {
    stack().appendChild(frame.root);
  }
  const uncover = opts.blockSlot ? coverWindow(opts.blockSlot) : () => {};
  if (opts.takeFocus) focusFirst(frame.root) || frame.root.focus({ preventScroll: true });

  let disposed = false;
  return {
    update: (next) => frame.update(next),
    focus: () => frame.focus(),
    dispose: (o) => {
      if (disposed) return;
      disposed = true;
      // Focus and the phone cover / inert come back right away; then the exit.
      frame.dispose();
      uncover();
      playExit(frame.root, () => { frame.root.remove(); releaseStack(); }, o);
    },
  };
}
