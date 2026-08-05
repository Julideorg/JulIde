export const MIME_MARKER = "%%JULIDE_MIME%%";

/** CSI sequences (colors, cursor, clear screen, etc.) for plain-text UI. */
// eslint-disable-next-line no-control-regex -- matching ESC is the whole purpose
const ANSI_CSI = /\u001b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;

/** OSC hyperlinks and similar (until BEL). */
// eslint-disable-next-line no-control-regex -- matching ESC/BEL is the whole purpose
const ANSI_OSC = /\u001b\][^\u0007]*\u0007/g;

/** Strip ANSI escapes so Monaco widgets and one-line summaries stay readable. */
export function stripAnsiForDisplay(s: string): string {
  return s.replace(ANSI_CSI, "").replace(ANSI_OSC, "");
}

export function parseMimeLine(text: string): { type: string; data: string } | null {
  const t = text.trimEnd();
  if (!t.startsWith(MIME_MARKER) || !t.endsWith("%%")) return null;
  try {
    const json = t.slice(MIME_MARKER.length, -2);
    const parsed = JSON.parse(json) as { type: string; data: string };
    if (typeof parsed.type === "string" && typeof parsed.data === "string") {
      return parsed;
    }
  } catch {
    // Not a valid MIME line
  }
  return null;
}
