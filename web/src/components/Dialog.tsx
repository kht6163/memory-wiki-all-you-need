import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Icon } from "./Icon.tsx";

/**
 * Modal on the native <dialog> (top layer, inert background, Esc handled by the browser).
 * Esc or a click on the backdrop calls onClose.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const downOnBackdrop = useRef(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // React's autoFocus runs before showModal(); move focus to the intended control explicitly.
      d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`dialog${className ? ` ${className}` : ""}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onMouseDown={(e) => (downOnBackdrop.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) e.currentTarget.close();
      }}
    >
      <div className="dialog-head">
        <h2 id={titleId} className="dialog-title">
          {title}
        </h2>
        <button className="icon-btn" aria-label="닫기" onClick={() => ref.current?.close()}>
          <Icon name="x" />
        </button>
      </div>
      {children !== undefined && <div className="dialog-body">{children}</div>}
      {footer && <div className="dialog-foot">{footer}</div>}
    </dialog>
  );
}

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  /** Label of the confirming button (default "확인"). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Filled red confirm button. */
  danger?: boolean;
  /** Require typing this exact text before the confirm button enables (e.g. a project name). */
  confirmText?: string;
}

/** `await confirmDialog({...})` → true when confirmed, false on cancel / Esc / backdrop. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (ok: boolean) => {
      resolve(ok);
      // Let the dialog's close event finish before tearing the tree down.
      setTimeout(() => {
        root.unmount();
        host.remove();
      });
    };
    root.render(<ConfirmView opts={opts} onDone={done} />);
  });
}

function ConfirmView({ opts, onDone }: { opts: ConfirmOptions; onDone: (ok: boolean) => void }) {
  const [open, setOpen] = useState(true);
  const [typed, setTyped] = useState("");
  const result = useRef(false);
  const blocked = opts.confirmText !== undefined && typed.trim() !== opts.confirmText;
  const finish = (ok: boolean) => {
    result.current = ok;
    setOpen(false);
  };
  return (
    <Dialog
      open={open}
      onClose={() => onDone(result.current)}
      title={opts.title}
      footer={
        <>
          <button className="btn" onClick={() => finish(false)} data-autofocus={opts.danger && opts.confirmText === undefined ? "" : undefined}>
            {opts.cancelLabel ?? "취소"}
          </button>
          <button
            className={`btn ${opts.danger ? "solid-danger" : "primary"}`}
            disabled={blocked}
            onClick={() => finish(true)}
            data-autofocus={!opts.danger && opts.confirmText === undefined ? "" : undefined}
          >
            {opts.confirmLabel ?? "확인"}
          </button>
        </>
      }
    >
      {opts.body}
      {opts.confirmText !== undefined && (
        <form
          className="dialog-confirm-text"
          onSubmit={(e) => {
            e.preventDefault();
            if (!blocked) finish(true);
          }}
        >
          <label>
            확인하려면 <b>{opts.confirmText}</b>을(를) 입력하세요
            <input value={typed} onChange={(e) => setTyped(e.target.value)} data-autofocus="" autoComplete="off" spellCheck={false} />
          </label>
        </form>
      )}
    </Dialog>
  );
}
