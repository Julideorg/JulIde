import { useEffect, type ReactNode } from "react";
import { create } from "zustand";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { iconSize } from "../../themes/tokens";
import { useAscii } from "../../services/ascii";
import { Button, IconButton, type Tone } from "./Button";
import { X } from "lucide-react";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
  /** Milliseconds before auto-dismiss. Errors persist until dismissed. */
  duration: number | null;
  action?: { label: string; onClick: () => void };
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, "id" | "duration"> & { duration?: number | null }) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

/** Errors stay until dismissed; everything else clears itself. */
const DEFAULT_DURATION: Record<ToastKind, number | null> = {
  info: 4000,
  success: 4000,
  warning: 8000,
  error: null,
};

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++;
    const duration = t.duration !== undefined ? t.duration : DEFAULT_DURATION[t.kind];
    set((s) => ({ toasts: [...s.toasts, { ...t, id, duration }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/**
 * Show a transient notification.
 *
 * julIDE had no notification system at all: `ctx.ui.showNotification()` and the
 * global error handler both appended a line to the Output panel, where anyone
 * not already looking at that panel would never see it.
 */
export const toast = {
  info: (title: string, message?: string) =>
    useToastStore.getState().push({ kind: "info", title, message }),
  success: (title: string, message?: string) =>
    useToastStore.getState().push({ kind: "success", title, message }),
  warning: (title: string, message?: string) =>
    useToastStore.getState().push({ kind: "warning", title, message }),
  error: (title: string, message?: string) =>
    useToastStore.getState().push({ kind: "error", title, message }),
};

const TONE: Record<ToastKind, Tone> = {
  info: "pkg",
  success: "run",
  warning: "help",
  error: "shell",
};

function Icon({ kind }: { kind: ToastKind }): ReactNode {
  const props = { size: iconSize.sm };
  if (kind === "success") return <CheckCircle2 {...props} />;
  if (kind === "warning") return <AlertTriangle {...props} />;
  if (kind === "error") return <XCircle {...props} />;
  return <Info {...props} />;
}

function ToastRow({ toast: t }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const ascii = useAscii();

  useEffect(() => {
    if (t.duration === null) return;
    const timer = setTimeout(() => dismiss(t.id), t.duration);
    return () => clearTimeout(timer);
  }, [t.id, t.duration, dismiss]);

  return (
    <div data-tone={TONE[t.kind]} className="ui-tone ui-toast">
      <span className="ui-toast-icon">
        <Icon kind={t.kind} />
      </span>
      <div className="ui-toast-content">
        {/*
          Most toast bodies are `String(err)`, which is where the messages Rust writes
          arrive. Folding here is the safety net for those and for plugin-supplied text;
          the five Rust literals that carry punctuation were also fixed at the source,
          because not every error reaches a toast — see useMarkdownImages.
        */}
        <div className="ui-toast-title">{ascii(t.title)}</div>
        {t.message && <div className="ui-toast-message">{ascii(t.message)}</div>}
        {t.action && (
          <div className="ui-toast-action">
            <Button
              size="sm"
              tone={TONE[t.kind]}
              onClick={() => {
                t.action?.onClick();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </Button>
          </div>
        )}
      </div>
      <IconButton label="Dismiss" onClick={() => dismiss(t.id)}>
        <X size={iconSize.xs} />
      </IconButton>
    </div>
  );
}

/** Mount once in App.tsx. */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;

  return (
    // `polite` so a background notification never interrupts what the user is
    // typing; errors that need immediate attention use a dialog instead.
    <div className="ui-toasts" role="region" aria-live="polite" aria-label="Notifications">
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} />
      ))}
    </div>
  );
}
