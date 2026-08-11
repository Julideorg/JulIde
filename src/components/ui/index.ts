/**
 * Shared UI primitives.
 *
 * Compose these rather than hand-rolling another panel header, button or
 * empty state — that is how the pre-redesign stylesheet ended up with two
 * interchangeable border radii and sixty different padding combinations.
 */

export { Button, IconButton, type Tone, type ButtonVariant } from "./Button";
export {
  Dialog,
  showConfirm,
  showUnsavedPrompt,
  ConfirmDialogHost,
  type ConfirmChoice,
} from "./Dialog";
export { Panel, EmptyState, Kbd, Badge, Dot, Spinner } from "./Panel";
export { Input, FieldShell } from "./Field";
export { Select, type SelectOption } from "./Select";
export { Popover, Menu, MenuItem, MenuSeparator } from "./Popover";
export { ToastHost, toast, useToastStore, type Toast, type ToastKind } from "./Toast";
