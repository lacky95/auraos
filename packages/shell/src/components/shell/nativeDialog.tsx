/**
 * nativeDialog — plain-HTML pieces for the top-bar dialogs (viewport settings,
 * About). No Radix primitives: the browser renders and handles them, so mouse,
 * finger, Apple Pencil and keyboard all work the same.
 *
 *   NativeDialog — fixed overlay frame, portaled into <body> (so the viewport
 *                  zoom/margins transform still applies), header with ✕,
 *                  Escape / backdrop to close, focus in on open, back on close.
 *   Btn          — <button> in the dialogs' looks (EXEC / OUTLINE / GHOST / ABORT).
 *   CheckBox     — drawn checkbox; the box and its label are one button.
 */
import * as React from 'react';
import { createPortal } from 'react-dom';

export type BtnTone = 'exec' | 'outline' | 'ghost' | 'abort';
export const BTN_SHAPE =
  'inline-flex items-center justify-center h-7 border border-solid cursor-pointer select-none transition-all duration-150 outline-none ' +
  'disabled:opacity-40 disabled:cursor-not-allowed';
const BTN_BASE = `${BTN_SHAPE} px-3 gap-1.5 font-mono font-medium uppercase text-[0.65rem] tracking-widest whitespace-nowrap`;
export const BTN_TONE: Record<BtnTone, string> = {
  exec: 'bg-transparent border-[var(--color-green)] text-[var(--color-green)] hover:bg-[var(--color-green)] hover:text-[var(--color-bg)] focus-visible:shadow-[var(--glow-green)]',
  outline: 'bg-[var(--surface)] border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-active)] hover:text-[var(--color-green)] focus-visible:border-[var(--border-active)]',
  ghost: 'bg-transparent border-transparent text-[var(--text-secondary)] hover:text-[var(--color-green)] hover:border-[var(--border)] focus-visible:border-[var(--border)]',
  abort: 'bg-transparent border-[var(--color-red)] text-[var(--color-red)] hover:bg-[var(--color-red)] hover:text-[var(--color-bg)] focus-visible:shadow-[var(--glow-red)]',
};

export function Btn({ tone = 'outline', className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: BtnTone }): React.JSX.Element {
  return <button type="button" className={`${BTN_BASE} ${BTN_TONE[tone]} ${className}`} {...rest} />;
}

const CheckMark = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="square" />
  </svg>
);

/** Drawn checkbox: the whole row (box + label) is one button. */
export function CheckBox({ checked, onChange, children, className = '', disabled }: {
  checked: boolean;
  onChange: (on: boolean) => void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`group inline-flex items-center gap-2 cursor-pointer bg-transparent border-none p-0 text-left outline-none disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      <span
        aria-hidden="true"
        className={
          'inline-flex h-4 w-4 shrink-0 items-center justify-center border transition-colors duration-100 ' +
          'group-focus-visible:shadow-[var(--glow-green)] ' +
          (checked
            ? 'border-[var(--color-green)] bg-[var(--color-green)] text-[var(--color-bg)]'
            : 'border-[var(--border-active,var(--border))] bg-[var(--surface)] text-transparent group-hover:border-[var(--color-green)]')
        }
      >
        <CheckMark />
      </span>
      {children}
    </button>
  );
}

/**
 * The dialog frame. Renders nothing while closed. z-[1055] (backdrop too): above
 * a focused activity, the launcher / process-manager panels and the Dock; below
 * the on-screen keyboard, notifications and the lock screen.
 */
export function NativeDialog({ open, onClose, title, icon, className = '', children, footer, role = 'viewport-dialog', panelRef, extra }: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  /** OS sprite icon name (lucide-…). */
  icon: string;
  /** Size classes for the panel, e.g. `max-w-md` or `max-w-3xl h-[80%]`. */
  className?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** data-role of the panel (tests / styling hooks). */
  role?: string;
  panelRef?: React.RefObject<HTMLDivElement | null>;
  /** Rendered last inside the panel (e.g. a layer for dropdown lists). */
  extra?: React.ReactNode;
}): React.JSX.Element {
  const ownRef = React.useRef<HTMLDivElement>(null);
  const ref = panelRef ?? ownRef;
  const titleId = React.useId();
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;

  // Focus moves into the panel on open and back to where it was on close.
  // Escape closes — bubble phase, so an open dropdown list stops its own Esc first.
  React.useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.stopPropagation(); closeRef.current(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      before?.focus?.();
    };
  }, [open, ref]);

  if (!open || typeof document === 'undefined') return <></>;

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[1055]"
        style={{ background: 'rgba(7, 5, 15, 0.88)' }}
        onClick={onClose}
        data-role={`${role}-backdrop`}
      />
      {/* Percent heights, not vh: a non-default viewport profile scales <body>
          (StatusBar.applyViewport), which makes it this panel's containing block,
          so % measures the AuraOS viewport with zoom + margins applied. */}
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-role={role}
        className={`fixed left-1/2 top-1/2 z-[1055] -translate-x-1/2 -translate-y-1/2 w-full flex flex-col max-h-[90%] border border-[var(--border)] bg-[var(--surface-raised)] shadow-[var(--glow-green)] outline-none ${className}`}
        style={{ clipPath: 'var(--clip-corner-md)' }}
      >
        <div className="shrink-0 flex items-center border-b border-[var(--border)] px-4 py-3">
          <h2 id={titleId} className="flex items-center gap-2 text-[var(--color-green)] text-sm font-bold tracking-widest uppercase m-0">
            <span aria-hidden="true"><svg className="aura-icon" aria-hidden="true"><use href={`/api/os/icons.svg#lucide-${icon}`} /></svg></span> {title}
          </h2>
          <span className="flex-1" />
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="cursor-pointer bg-transparent border-none px-1 font-mono text-[0.8rem] leading-none text-[var(--text-muted)] hover:text-[var(--color-red)]"
          >
            ✕
          </button>
        </div>
        {children}
        {footer && <div className="shrink-0 border-t border-[var(--border)] px-4 py-3">{footer}</div>}
        {extra}
      </div>
    </>,
    document.body,
  );
}
