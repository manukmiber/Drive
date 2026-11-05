import { useEffect, useRef, type ReactNode } from 'react';
import { t } from '../../lib/i18n';
import { Button } from '../Button';

/** Native <dialog> modal: focus trap, Esc and backdrop handled by the browser. */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto w-[min(92vw,26rem)] rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-0 text-[var(--text)] shadow-xl backdrop:bg-black/55"
    >
      {open && (
        <div className="p-5">
          <h2 className="text-lg leading-snug font-bold">{title}</h2>
          <div className="mt-3 text-sm">{children}</div>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            {footer ?? (
              <Button variant="ghost" onClick={onClose}>
                {t.common.close}
              </Button>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}

export function PromptDialog({
  open,
  title,
  initial,
  confirmLabel,
  onCancel,
  onSubmit,
  selectBase = false,
}: {
  open: boolean;
  title: string;
  initial: string;
  confirmLabel: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
  selectBase?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const el = input.current;
    if (!el) return;
    el.value = initial;
    el.focus();
    const dot = initial.lastIndexOf('.');
    el.setSelectionRange(0, selectBase && dot > 0 ? dot : initial.length);
  }, [open, initial, selectBase]);
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t.common.cancel}
          </Button>
          <Button type="submit" form="prompt-form">
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        id="prompt-form"
        onSubmit={(e) => {
          e.preventDefault();
          const v = input.current?.value.trim();
          if (v) onSubmit(v);
        }}
      >
        <input
          ref={input}
          aria-label={title}
          className="h-11 w-full rounded-lg border border-[var(--line-strong)] bg-[var(--surface)] px-3 text-base outline-none focus:border-[var(--ink)] sm:text-sm"
          maxLength={255}
        />
      </form>
    </Dialog>
  );
}
