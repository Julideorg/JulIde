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
  /**
   * A third answer, between confirming and cancelling — "Don't Save" against a "Save".
   *
   * Optional because two buttons is the normal case. Sharing one store and one host
   * rather than standing up a parallel set for the one dialog that needs three: the
   * focus trap, the scrim rules and the `alertdialog` role are the fiddly parts, and
   * they should not exist twice.
   */
  secondaryLabel?: string;
  resolve: (choice: ConfirmChoice) => void;
}

/** `confirm` is the primary button, `secondary` the middle one where there is one. */
export type ConfirmChoice = "confirm" | "secondary" | "cancel";

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
      resolve: (choice) => resolve(choice === "confirm"),
    });
  });
}

/**
 * Ask what to do about a file with unsaved changes.
 *
 * Escape and the scrim both mean "cancel" — the safe answer, and the one that leaves
 * the work where it is. Discarding is deliberately the middle button rather than the
 * primary one, so the emphasised action is the one that keeps the file.
 */
export function showUnsavedPrompt(fileName: string): Promise<"save" | "discard" | "cancel"> {
  return new Promise((resolve) => {
    useConfirmStore.getState().open({
      title: "Unsaved changes",
      message: `Do you want to save the changes you made to ${fileName}?`,
      confirmLabel: "Save",
      secondaryLabel: "Don't Save",
      tone: "brand",
      resolve: (choice) =>
        resolve(choice === "confirm" ? "save" : choice === "secondary" ? "discard" : "cancel"),
    });
  });
}

/** Mount once, near the other overlays in App.tsx. */
export function ConfirmDialogHost() {
  const request = useConfirmStore((s) => s.request);
  const close = useConfirmStore((s) => s.close);

  const settle = (choice: ConfirmChoice) => {
    request?.resolve(choice);
    close();
  };

  return (
    <Dialog
      open={request !== null}
      role="alertdialog"
      title={request?.title ?? ""}
      onClose={() => settle("cancel")}
      footer={
        <>
          <Button onClick={() => settle("cancel")}>Cancel</Button>
          {request?.secondaryLabel && (
            <Button onClick={() => settle("secondary")}>{request.secondaryLabel}</Button>
          )}
          <Button
            variant="filled"
            tone={request?.tone ?? "shell"}
            onClick={() => settle("confirm")}
          >
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
