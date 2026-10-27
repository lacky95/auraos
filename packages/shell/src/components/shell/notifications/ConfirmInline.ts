/**
 * ConfirmInline — the shell's reusable two-step confirmation, rendered in
 * place (inside a menu, a card, a toolbar) instead of a modal.
 *
 *   const c = createConfirmInline({
 *     message: 'Remove anyway? The sender will be told.',
 *     confirmLabel: 'Remove', danger: true,
 *     onConfirm: async () => (await doIt()).ok,   // false → stays open
 *     onCancel: () => menu.close(),
 *   });
 *   host.appendChild(c.el); c.focus();
 *
 * Keyboard: focus starts on the confirm button (Enter confirms); Escape
 * cancels (handled here and stopped, so an enclosing panel does not close —
 * the root carries `data-own-escape`); Tab cycles between the two buttons.
 * While `onConfirm` runs both buttons are disabled and the root is
 * `aria-busy`. A failure message can be shown with `setError`.
 *
 * Built with the DOM API only (no innerHTML). Styles: NotificationStyles.astro
 * (`.aura-confirm*`).
 */
export interface ConfirmInlineOptions {
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
  /** Return false (or a rejected promise) to keep the confirm open. */
  onConfirm: () => boolean | void | Promise<boolean | void>;
  onCancel?: () => void;
  /** Extra lines under the message (e.g. "Your entered answers will be lost."). */
  notes?: string[];
  /**
   * An extra, preferred action shown FIRST and focused (e.g. "Answer").
   * Enter on it runs it; the confirm button becomes the second choice.
   */
  primary?: { label: string; onClick: () => void };
}

export interface ConfirmInline {
  el: HTMLElement;
  focus(): void;
  setError(msg: string): void;
  dispose(): void;
}

let seq = 0;

export function createConfirmInline(opts: ConfirmInlineOptions): ConfirmInline {
  const id = `aura-confirm-${++seq}`;
  const root = document.createElement('div');
  root.className = 'aura-confirm';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-labelledby', `${id}-msg`);
  root.dataset['ownEscape'] = 'true';

  const msg = document.createElement('p');
  msg.className = 'aura-confirm-msg';
  msg.id = `${id}-msg`;
  msg.textContent = opts.message;
  const notes = (opts.notes ?? []).map((t) => {
    const p = document.createElement('p');
    p.className = 'aura-confirm-note';
    p.textContent = t;
    return p;
  });

  const row = document.createElement('div');
  row.className = 'aura-confirm-row';
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'aura-confirm-btn';
  yes.dataset['role'] = 'confirm';
  if (opts.danger) yes.dataset['danger'] = 'true';
  yes.textContent = opts.confirmLabel ?? 'Confirm';
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'aura-confirm-btn';
  no.dataset['role'] = 'cancel';
  no.textContent = opts.cancelLabel ?? 'Cancel';
  let first: HTMLButtonElement | null = null;
  if (opts.primary) {
    first = document.createElement('button');
    first.type = 'button';
    first.className = 'aura-confirm-btn';
    first.dataset['role'] = 'primary';
    first.textContent = opts.primary.label;
    const run = opts.primary.onClick;
    first.addEventListener('click', () => { if (!busy && !disposed) run(); });
    row.append(first);
  }
  row.append(yes, no);

  const err = document.createElement('p');
  err.className = 'aura-confirm-error';
  err.setAttribute('role', 'alert');
  err.hidden = true;

  root.append(msg, ...notes, row, err);

  let busy = false;
  let disposed = false;

  const cancel = () => {
    if (busy || disposed) return;
    opts.onCancel?.();
  };
  const confirm = async () => {
    if (busy || disposed) return;
    busy = true;
    root.setAttribute('aria-busy', 'true');
    yes.disabled = true;
    no.disabled = true;
    let ok = true;
    try {
      ok = (await opts.onConfirm()) !== false;
    } catch (e) {
      ok = false;
      setError(String((e as Error)?.message ?? e));
    } finally {
      busy = false;
      if (root.isConnected) {
        root.removeAttribute('aria-busy');
        yes.disabled = false;
        no.disabled = false;
        if (!ok) yes.focus({ preventScroll: true });
      }
    }
  };
  function setError(m: string) {
    err.textContent = m;
    err.hidden = !m;
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === 'Tab') {
      // Two buttons: keep Tab inside the confirm.
      const order = first ? [first, yes, no] : [yes, no];
      const i = order.indexOf(document.activeElement as HTMLButtonElement);
      if (i === -1) return;
      e.preventDefault();
      order[(i + (e.shiftKey ? order.length - 1 : 1)) % order.length]!.focus();
    } else if (e.key === 'Enter' && document.activeElement === yes) {
      e.preventDefault();
      void confirm();
    }
  };
  root.addEventListener('keydown', onKey);
  yes.addEventListener('click', () => { void confirm(); });
  no.addEventListener('click', cancel);

  return {
    el: root,
    focus: () => (first ?? yes).focus({ preventScroll: true }),
    setError,
    dispose: () => {
      disposed = true;
      root.removeEventListener('keydown', onKey);
      root.remove();
    },
  };
}
