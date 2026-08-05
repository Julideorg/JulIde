import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Open a URL in the user's browser, refusing anything that isn't http(s).
 *
 * The URLs passed here come from Git provider API responses (GitHub/GitLab/Gitea),
 * and the Gitea provider talks to whatever host the repo's `origin` points at.
 * `opener:default` carries no scheme scope, so without this check a hostile or
 * compromised instance could return a `file://` or custom-scheme URL and have the
 * host OS act on it.
 */
export async function openExternal(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Refusing to open malformed URL: ${url}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Refusing to open non-http(s) URL: ${parsed.protocol}//…`);
  }

  await openUrl(parsed.toString());
}
