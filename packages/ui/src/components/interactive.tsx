'use client';

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { Icons, type IconName } from './icons';
import { ActionButton, IconButton, type ActionButtonProps } from './phase8';

/**
 * The stateful primitives: transient toasts, the confirm dialog and the bottom sheet, each
 * on the native platform behaviour (a `<dialog>` brings focus trapping, Escape and the
 * backdrop) and styled by `components.css`; the sheet's rise and fall and the backdrop's
 * blur are transitions 5 in motion.css.
 */

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---- Toast -----------------------------------------------------------------------------------

export type ToastTone = 'neutral' | 'success' | 'error';

export type ToastInput = { title: string; body?: string; tone?: ToastTone; /** ms; 0 keeps it until dismissed. */ durationMs?: number };

type ToastItem = { id: number; title: string; body: string | undefined; tone: ToastTone; durationMs: number };

type ToastContextValue = { toast: (input: ToastInput) => number; dismiss: (id: number) => void };

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_ICON: Record<ToastTone, IconName> = { neutral: 'info', success: 'circleCheck', error: 'circleAlert' };

/**
 * Transient notices: announced politely, dismissible, never for something the user must act
 * on (that is `ConfirmDialog`'s job).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      const item: ToastItem = { id, title: input.title, body: input.body, tone: input.tone ?? 'neutral', durationMs: input.durationMs ?? 5000 };
      setItems((list) => [...list, item]);
      if (item.durationMs > 0) timers.current.set(id, setTimeout(() => dismiss(id), item.durationMs));
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" aria-relevant="additions" className="so-toast-viewport">
        {items.map((item) => {
          const Icon = Icons[TOAST_ICON[item.tone]];
          return (
            <div key={item.id} role="status" className="so-toast" data-tone={item.tone}>
              <span className={cx('so-toast__icon', item.tone !== 'neutral' && `so-toast__icon--${item.tone}`)}>
                <Icon size={18} />
              </span>
              <div className="so-toast__content">
                <p className="so-toast__title">{item.title}</p>
                {item.body === undefined ? null : <p className="so-toast__body">{item.body}</p>}
              </div>
              <IconButton label="Dismiss" onClick={() => dismiss(item.id)}>
                <Icons.x size={16} />
              </IconButton>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context === null) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}

// ---- Confirm dialog ---------------------------------------------------------------------------

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * A modal confirm on the native `<dialog>`: focus trapping, Escape and the blurred backdrop
 * come from the platform. The confirm button is the screen's one primary action while the
 * dialog is open; a destructive confirm uses `danger`.
 */
export function ConfirmDialog({ open, title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', destructive = false, busy = false, onConfirm, onCancel }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="so-dialog"
      aria-labelledby={titleId}
      aria-describedby={body === undefined ? undefined : bodyId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(event) => {
        if (event.target === ref.current && !busy) onCancel();
      }}
    >
      <div className="so-dialog__panel">
        <h2 id={titleId} className="so-dialog__title">
          {title}
        </h2>
        {body === undefined ? null : (
          <div id={bodyId} className="so-dialog__body">
            {body}
          </div>
        )}
        <div className="so-dialog__actions">
          <ActionButton variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </ActionButton>
          <ActionButton variant={destructive ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy} aria-busy={busy}>
            {confirmLabel}
          </ActionButton>
        </div>
      </div>
    </dialog>
  );
}

// ---- Bottom sheet -----------------------------------------------------------------------------

export type SheetProps = {
  open: boolean;
  title: string;
  subtitle?: string | undefined;
  /** Refuse to close (a request in flight). */
  locked?: boolean;
  /** Called once the exit animation has finished (or at once without animation support). */
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  testId?: string;
};

const SheetCloseContext = createContext<(() => void) | null>(null);

/** Inside a `Sheet`: ask it to close (it plays its exit first). */
export function useSheetClose(): () => void {
  const close = useContext(SheetCloseContext);
  if (close === null) throw new Error('useSheetClose must be used inside <Sheet>');
  return close;
}

/** A button inside a `Sheet` that closes it through the exit animation. */
export function SheetCloseButton(props: Omit<ActionButtonProps, 'onClick'>) {
  const close = useSheetClose();
  return <ActionButton {...props} onClick={close} />;
}

/**
 * The bottom sheet (spec 5.3 "thumb-reachable", transition 5): a native `<dialog>` pinned to
 * the bottom edge that rises on translateY behind a blurred backdrop and slides back down
 * on close. Focus lands on the panel itself so the first thing announced is the sheet.
 * `onClose` fires once the exit has played; buttons inside close it through
 * `SheetCloseButton` or `useSheetClose`.
 */
export function Sheet({ open, title, subtitle, locked = false, onClose, children, footer, testId }: SheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
      panelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const finish = useCallback(() => {
    setClosing(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!closing) return;
    const panel = panelRef.current;
    const running = panel !== null && typeof panel.getAnimations === 'function' ? panel.getAnimations() : [];
    if (running.length === 0) {
      finish();
      return;
    }
    let cancelled = false;
    void Promise.allSettled(running.map((animation) => animation.finished)).then(() => {
      if (!cancelled) finish();
    });
    return () => {
      cancelled = true;
    };
  }, [closing, finish]);

  const requestClose = () => {
    if (locked) return;
    if (!closing) setClosing(true);
  };

  return (
    <dialog
      ref={dialogRef}
      className="so-sheet"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) requestClose();
      }}
    >
      {open ? (
        <SheetCloseContext.Provider value={requestClose}>
          <div ref={panelRef} tabIndex={-1} className={cx('so-sheet__panel', closing ? 'sheet-exit' : 'sheet-enter')} data-testid={testId} data-closing={closing ? 'true' : undefined}>
            <div className="so-sheet__grip" aria-hidden="true" />
            <div className="so-sheet__head">
              <div style={{ minWidth: 0 }}>
                <h2 id={titleId} className="so-sheet__title">
                  {title}
                </h2>
                {subtitle === undefined ? null : <p className="so-sheet__subtitle">{subtitle}</p>}
              </div>
              <IconButton label="Close" onClick={requestClose} disabled={locked}>
                <Icons.x size={20} />
              </IconButton>
            </div>
            <div className="so-sheet__body">{children}</div>
            {footer === undefined ? null : <div className="so-sheet__foot">{footer}</div>}
          </div>
        </SheetCloseContext.Provider>
      ) : null}
    </dialog>
  );
}

