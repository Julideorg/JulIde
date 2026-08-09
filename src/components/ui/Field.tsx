import { useId, type InputHTMLAttributes, type ReactNode } from "react";

interface FieldShellProps {
  label?: string;
  hint?: ReactNode;
  error?: string;
  /**
   * Override the generated id. `SettingRow` injects an id into its child via
   * `cloneElement`, and that id has to reach the control for the label to be associated
   * with it — a mismatch is silent, so it is threaded explicitly rather than generated.
   */
  id?: string;
  children: (id: string) => ReactNode;
}

/** Wraps a control with a label, hint and error slot, wired up by id. */
export function FieldShell({ label, hint, error, id: idProp, children }: FieldShellProps) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <div className="ui-field">
      {label && (
        <label className="ui-field-label" htmlFor={id}>
          {label}
        </label>
      )}
      {children(id)}
      {error ? (
        <span className="ui-field-error">{error}</span>
      ) : (
        hint && <span className="ui-field-hint">{hint}</span>
      )}
    </div>
  );
}

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: string;
  hint?: ReactNode;
  error?: string;
  /** Use for paths, versions, and anything the user compares character by character. */
  mono?: boolean;
}

export function Input({ label, hint, error, mono, className = "", id, ...rest }: InputProps) {
  return (
    <FieldShell label={label} hint={hint} error={error} id={id}>
      {(id) => (
        <input
          id={id}
          aria-invalid={error ? true : undefined}
          className={`ui-input${mono ? " ui-input--mono" : ""} ${className}`.trim()}
          {...rest}
        />
      )}
    </FieldShell>
  );
}

// `Select` lives in ./Select.tsx — it is a themed listbox rather than a native
// <select>, because the platform draws that popup and will not theme it.
