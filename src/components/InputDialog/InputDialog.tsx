import { useState, useEffect, useRef, useCallback } from "react";
import { useModalA11y } from "../../hooks/useModalA11y";
import { create } from "zustand";

interface InputDialogState {
  open: boolean;
  title: string;
  placeholder: string;
  defaultValue: string;
  validate: ((value: string) => string | null) | null;
  resolve: ((value: string | null) => void) | null;
}

const useInputDialogStore = create<InputDialogState>(() => ({
  open: false,
  title: "",
  placeholder: "",
  defaultValue: "",
  validate: null,
  resolve: null,
}));

export interface InputDialogOptions {
  title: string;
  placeholder?: string;
  defaultValue?: string;
  validate?: (value: string) => string | null;
}

export function showInputDialog(opts: InputDialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    useInputDialogStore.setState({
      open: true,
      title: opts.title,
      placeholder: opts.placeholder ?? "",
      defaultValue: opts.defaultValue ?? "",
      validate: opts.validate ?? null,
      resolve,
    });
  });
}

export function InputDialog() {
  const { open, title, placeholder, defaultValue, validate, resolve } = useInputDialogStore();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue(defaultValue);
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, defaultValue]);

  const close = useCallback(
    (result: string | null) => {
      useInputDialogStore.setState({
        open: false,
        resolve: null,
        validate: null,
      });
      resolve?.(result);
    },
    [resolve],
  );

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (validate) {
      const err = validate(trimmed);
      if (err) {
        setError(err);
        return;
      }
    }
    close(trimmed);
  }, [value, validate, close]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        close(null);
      }
    },
    [submit, close],
  );

  // Traps Tab inside the dialog and restores focus to wherever it was on close.
  const dialogRef = useModalA11y<HTMLDivElement>(open, { skipInitialFocus: true });

  if (!open) return null;

  return (
    <div className="input-dialog-overlay" onClick={() => close(null)}>
      <div
        ref={dialogRef}
        className="input-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Input"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="input-dialog-title">{title}</div>
        <input
          ref={inputRef}
          className="input-dialog-input"
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={handleKeyDown}
        />
        {error && <div className="input-dialog-error">{error}</div>}
        <div className="input-dialog-actions">
          <button className="input-dialog-btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button className="input-dialog-btn primary" onClick={submit}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
