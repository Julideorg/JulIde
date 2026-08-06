import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Tone maps a control onto Julia's REPL modes, so colour carries the same
 * meaning everywhere: `run` for executing things, `pkg` for package and
 * environment work, `help` for docs and warnings, `shell` for destructive or
 * failing actions, `brand` for identity and selection.
 */
export type Tone = "neutral" | "brand" | "run" | "pkg" | "help" | "shell";

export type ButtonVariant = "filled" | "outline" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  tone?: Tone;
  size?: "sm" | "md";
  /** Rendered before the label. Use an icon at `iconSize.sm`. */
  icon?: ReactNode;
}

export function Button({
  variant = "outline",
  tone = "neutral",
  size = "sm",
  icon,
  children,
  className = "",
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      data-tone={tone}
      className={`ui-tone ui-btn ui-btn--${variant} ui-btn--${size} ${className}`.trim()}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon alone is not a label. Becomes the tooltip too. */
  label: string;
  tone?: Tone;
  children: ReactNode;
}

/**
 * A square, label-less control. `label` is mandatory because the pre-redesign
 * chrome had several icon-only buttons with no accessible name at all.
 */
export function IconButton({
  label,
  tone = "neutral",
  children,
  className = "",
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      data-tone={tone}
      className={`ui-tone ui-icon-btn ${className}`.trim()}
      {...rest}
    >
      {children}
    </button>
  );
}
