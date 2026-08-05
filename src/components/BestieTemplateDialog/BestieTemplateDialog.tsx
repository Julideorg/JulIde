import { useState, useEffect, useRef } from "react";
import { useModalA11y } from "../../hooks/useModalA11y";
import { create } from "zustand";

export interface BestieTemplateData {
  packageName: string;
  packageOwner: string;
  authors: string;
  juliaMinVersion: string;
  license: string;
  strategyLevel: number;
}

interface DialogState {
  open: boolean;
  resolve: ((value: BestieTemplateData | null) => void) | null;
}

const useStore = create<DialogState>(() => ({
  open: false,
  resolve: null,
}));

export function showBestieTemplateDialog(): Promise<BestieTemplateData | null> {
  return new Promise((resolve) => {
    useStore.setState({ open: true, resolve });
  });
}

const LICENSES = ["MIT", "Apache-2.0", "GPL-3.0", "MPL-2.0"];
const STRATEGIES = [
  { value: 0, label: "Tiny — minimal setup" },
  { value: 1, label: "Light — recommended defaults" },
  { value: 2, label: "Moderate — CI, docs, formatter" },
  { value: 3, label: "Robust — all best-practice features" },
];

export function BestieTemplateDialog() {
  const { open, resolve } = useStore();
  const [data, setData] = useState<BestieTemplateData>({
    packageName: "",
    packageOwner: "",
    authors: "",
    juliaMinVersion: "1.6",
    license: "MIT",
    strategyLevel: 1,
  });
  const [error, setError] = useState<string | null>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setData({
        packageName: "",
        packageOwner: "",
        authors: "",
        juliaMinVersion: "1.6",
        license: "MIT",
        strategyLevel: 1,
      });
      setError(null);
      setTimeout(() => firstInputRef.current?.focus(), 50);
    }
  }, [open]);

  const close = (result: BestieTemplateData | null) => {
    useStore.setState({ open: false, resolve: null });
    resolve?.(result);
  };

  const submit = () => {
    if (!data.packageName.trim()) {
      setError("Package name is required");
      return;
    }
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(data.packageName.trim())) {
      setError("Package name must start with a letter and contain only letters/digits");
      return;
    }
    if (!data.packageOwner.trim()) {
      setError("Package owner is required");
      return;
    }
    if (!data.authors.trim()) {
      setError("At least one author is required");
      return;
    }
    close({
      ...data,
      packageName: data.packageName.trim(),
      packageOwner: data.packageOwner.trim(),
      authors: data.authors.trim(),
      juliaMinVersion: data.juliaMinVersion.trim() || "1.6",
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") close(null);
    if (e.key === "Enter" && e.ctrlKey) submit();
  };

  // Traps Tab inside the dialog and restores focus to wherever it was on close.
  const dialogRef = useModalA11y<HTMLDivElement>(open, {});

  if (!open) return null;

  const field = (
    label: string,
    key: keyof BestieTemplateData,
    opts?: { placeholder?: string; ref?: React.Ref<HTMLInputElement> },
  ) => (
    <label className="bestie-field" key={key}>
      <span className="bestie-field-label">{label}</span>
      <input
        ref={opts?.ref}
        className="bestie-field-input"
        placeholder={opts?.placeholder}
        value={String(data[key])}
        onChange={(e) => {
          setData((d) => ({ ...d, [key]: e.target.value }));
          setError(null);
        }}
        onKeyDown={handleKeyDown}
      />
    </label>
  );

  return (
    <div className="input-dialog-overlay" onClick={() => close(null)}>
      <div
        ref={dialogRef}
        className="bestie-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New project from BestieTemplate"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="bestie-dialog-title">New Project — BestieTemplate</div>

        <div className="bestie-dialog-body">
          {field("Package Name", "packageName", {
            placeholder: "MyPackage",
            ref: firstInputRef,
          })}
          {field("GitHub Owner", "packageOwner", {
            placeholder: "your-username",
          })}
          {field("Authors", "authors", {
            placeholder: "First Last <email@example.com>",
          })}
          {field("Min Julia Version", "juliaMinVersion", {
            placeholder: "1.6",
          })}

          <label className="bestie-field">
            <span className="bestie-field-label">License</span>
            <select
              className="bestie-field-select"
              value={data.license}
              onChange={(e) => setData((d) => ({ ...d, license: e.target.value }))}
            >
              {LICENSES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>

          <label className="bestie-field">
            <span className="bestie-field-label">Strategy</span>
            <select
              className="bestie-field-select"
              value={data.strategyLevel}
              onChange={(e) => setData((d) => ({ ...d, strategyLevel: Number(e.target.value) }))}
            >
              {STRATEGIES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          {error && <div className="input-dialog-error">{error}</div>}
        </div>

        <div className="input-dialog-actions">
          <button className="input-dialog-btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button className="input-dialog-btn primary" onClick={submit}>
            Create Project
          </button>
        </div>
      </div>
    </div>
  );
}
