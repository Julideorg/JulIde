import type { ReactNode } from "react";
import { create } from "zustand";
import { useModalA11y } from "../../hooks/useModalA11y";
import { Button, type Tone } from "./Button";

interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** `alertdialog` for destructive confirmations, so screen readers interrupt. */
  role?: "dialog" | "alertdialog";
}

/**
 * A modal dialog with focus trapping, Escape-to-close, and scrim dismissal.
 *
 * Use this instead of hand-building an overlay. The file-delete confirmation
 * this replaced was assembled with `document.createElement` and inline
 * `style.cssText`, so it ignored the theme entirely and rendered dark chrome
 * on top of the light theme.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
  role = "dialog",
}: DialogProps) {
  const ref = useModalA11y<HTMLDivElement>(open, { onEscape: onClose });
  if (!open) return null;

  const titleId = `ui-dialog-title-${title.replace(/\W+/g, "-").toLowerCase()}`;

  return (
    <div
      className="ui-scrim"
      onMouseDown={(e) => {
        // Only a press that both starts and ends on the scrim dismisses, so a
        // drag that happens to release outside the dialog doesn't close it.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        className={`ui-dialog${wide ? " ui-dialog--wide" : ""}`}
      >
        <div className="ui-dialog-header">
          <h2 id={titleId} className="ui-dialog-title">
            {title}
          </h2>
        </div>
        <div className="ui-dialog-body">{children}</div>
        {footer && <div className="ui-dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}

/* ── Imperative confirmation ────────────────────────────────────────────
   Some callers (context menus, file operations) need a promise rather than
   rendered state. This keeps the React rendering path while offering the
   same call shape the old imperative helper had. */

interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  tone: Tone;
  resolve: (ok: boolean) => void;
}

interface ConfirmState {
  request: ConfirmRequest | null;
  open: (r: ConfirmRequest) => void;
  close: () => void;
}

const useConfirmStore = create<ConfirmState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  /** `shell` (red) for destructive actions — the default. */
  tone?: Tone;
}

/** Ask the user to confirm. Resolves true if they accept. */
export function showConfirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirmStore.getState().open({
      title: options.title ?? "Are you sure?",
      message,
      confirmLabel: options.confirmLabel ?? "Delete",
      tone: options.tone ?? "shell",
      resolve,
    });
  });
}

/** Mount once, near the other overlays in App.tsx. */
export function ConfirmDialogHost() {
  const request = useConfirmStore((s) => s.request);
  const close = useConfirmStore((s) => s.close);

  const settle = (ok: boolean) => {
    request?.resolve(ok);
    close();
  };

  return (
    <Dialog
      open={request !== null}
      role="alertdialog"
      title={request?.title ?? ""}
      onClose={() => settle(false)}
      footer={
        <>
          <Button onClick={() => settle(false)}>Cancel</Button>
          <Button variant="filled" tone={request?.tone ?? "shell"} onClick={() => settle(true)}>
            {request?.confirmLabel}
          </Button>
        </>
      }
    >
      {/* Rendered as text, never as markup — a filename is untrusted input. */}
      <p>{request?.message}</p>
    </Dialog>
  );
}
