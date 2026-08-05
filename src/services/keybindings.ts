export interface Keybinding {
  key: string;
  ctrlOrCmd: boolean;
  shift?: boolean;
  alt?: boolean;
  label: string;
}

export const DEFAULT_KEYBINDINGS: Record<string, Keybinding> = {
  "command-palette": { key: "P", ctrlOrCmd: true, shift: true, label: "⌘⇧P" },
  "quick-open": { key: "p", ctrlOrCmd: true, label: "⌘P" },
  find: { key: "f", ctrlOrCmd: true, label: "⌘F" },
  "find-replace": { key: "h", ctrlOrCmd: true, label: "⌘H" },
  "global-search": { key: "F", ctrlOrCmd: true, shift: true, label: "⌘⇧F" },
  "toggle-terminal": { key: "`", ctrlOrCmd: true, label: "⌃`" },
  "open-settings": { key: ",", ctrlOrCmd: true, label: "⌘," },
  "run-file": { key: "F5", ctrlOrCmd: true, label: "⌃F5" },
  "go-to-line": { key: "g", ctrlOrCmd: true, label: "⌘G" },
};

export function matchesKeybinding(e: KeyboardEvent, binding: Keybinding): boolean {
  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  if (binding.ctrlOrCmd && !ctrlOrCmd) return false;
  if (binding.shift && !e.shiftKey) return false;
  if (binding.alt && !e.altKey) return false;
  return e.key === binding.key;
}

export function getKeybindingLabel(actionId: string): string {
  return DEFAULT_KEYBINDINGS[actionId]?.label ?? "";
}
