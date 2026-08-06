import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

interface FieldShellProps {
  label?: string;
  hint?: ReactNode;
  error?: string;
  children: (id: string) => ReactNode;
}

/** Wraps a control with a label, hint and error slot, wired up by id. */
function FieldShell({ label, hint, error, children }: FieldShellProps) {
  const id = useId();
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

export function Input({ label, hint, error, mono, className = "", ...rest }: InputProps) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
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

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}

export function Select({ label, hint, error, children, className = "", ...rest }: SelectProps) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {(id) => (
        <select id={id} className={`ui-select ${className}`.trim()} {...rest}>
          {children}
        </select>
      )}
    </FieldShell>
  );
}
