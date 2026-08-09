/**
 * Keyboard behaviour for the Select listbox, as pure functions.
 *
 * Kept out of the component for the same reason `ModeBar/fuzzy.ts` is: there is no DOM
 * test environment here, so anything that needs real coverage has to be expressible
 * without one. Arrow navigation and type-to-select are exactly the parts worth testing.
 */

export interface NavOption {
  label: string;
  disabled?: boolean;
}

/** How long a typeahead buffer survives between keystrokes. */
export const TYPEAHEAD_RESET_MS = 500;

/** First enabled index at or after `from`, scanning in `step` direction. `null` if none. */
function firstEnabled(options: readonly NavOption[], from: number, step: 1 | -1): number | null {
  for (let i = from; i >= 0 && i < options.length; i += step) {
    if (!options[i].disabled) return i;
  }
  return null;
}

/** Index of the first enabled option, or -1 when every option is disabled. */
export function firstEnabledIndex(options: readonly NavOption[]): number {
  return firstEnabled(options, 0, 1) ?? -1;
}

/** Index of the last enabled option, or -1 when every option is disabled. */
export function lastEnabledIndex(options: readonly NavOption[]): number {
  return firstEnabled(options, options.length - 1, -1) ?? -1;
}

/**
 * Next active index for a navigation key, or `null` if the key does not navigate.
 *
 * Clamps at both ends rather than wrapping — matching the ModeBar result list, and
 * matching a native <select>, where holding ArrowDown parks on the last option instead
 * of cycling back to the top.
 */
export function nextIndex(
  key: string,
  current: number,
  options: readonly NavOption[],
): number | null {
  if (options.length === 0) return null;

  switch (key) {
    case "ArrowDown":
      return firstEnabled(options, current + 1, 1) ?? (current >= 0 ? current : null);
    case "ArrowUp":
      return firstEnabled(options, current - 1, -1) ?? (current >= 0 ? current : null);
    case "Home":
      return firstEnabled(options, 0, 1);
    case "End":
      return firstEnabled(options, options.length - 1, -1);
    default:
      return null;
  }
}

/** True for keys that should extend the typeahead buffer rather than do anything else. */
export function isTypeaheadKey(key: string): boolean {
  // Single printable character, and not a space — space commits the active option, which
  // is what a native <select> does too.
  return key.length === 1 && key !== " " && !/\s/.test(key);
}

/** Extend the typeahead buffer, restarting it once the user has paused. */
export function appendTypeahead(buffer: string, key: string, elapsedMs: number): string {
  return elapsedMs > TYPEAHEAD_RESET_MS ? key : buffer + key;
}

/**
 * Index matching `buffer`, searching forward from `from` and wrapping once.
 *
 * A buffer of one repeated character ("aaa") cycles through the options starting with
 * that letter, which is the long-standing native behaviour for repeated keypresses.
 * Returns -1 when nothing matches, so the caller can leave the active index alone.
 */
export function typeaheadIndex(
  options: readonly NavOption[],
  buffer: string,
  from: number,
): number {
  if (!buffer) return -1;

  const repeated = buffer.length > 1 && [...buffer].every((c) => c === buffer[0]);
  const needle = (repeated ? buffer[0] : buffer).toLowerCase();

  // Start one past the current option so a repeated letter advances instead of sticking.
  const start = repeated ? from + 1 : from;

  for (let i = 0; i < options.length; i++) {
    const idx = (((start + i) % options.length) + options.length) % options.length;
    const o = options[idx];
    if (!o.disabled && o.label.toLowerCase().startsWith(needle)) return idx;
  }
  return -1;
}
