import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, CheckCircle2, Download, FolderSearch, RefreshCw } from "lucide-react";
import { useJuliaStore } from "../../stores/useJuliaStore";
import { openExternal } from "../../services/openExternal";
import type { JuliaOutputEvent } from "../../types";

const JULIA_DOWNLOAD_URL = "https://julialang.org/downloads/";

/**
 * Optional packages that unlock major features. Each blocks a headline capability
 * if missing, and each previously failed with a raw "run Pkg.add(...)" string in the
 * Output panel — a dead end for anyone who has not used Julia's REPL before.
 */
const OPTIONAL_PACKAGES = [
  { name: "LanguageServer", unlocks: "Autocomplete, hover docs, go-to-definition, diagnostics" },
  { name: "Revise", unlocks: "Hot-reload of edited code in the REPL" },
  { name: "Debugger", unlocks: "Breakpoints and step-through debugging" },
  { name: "Pluto", unlocks: "Reactive notebooks" },
] as const;

/**
 * Guided setup shown when Julia cannot be found.
 *
 * julIDE does not bundle Julia and every core feature depends on it, so "Julia not
 * found" needs to be a place the user can act, not a status string. This offers the
 * three things that actually resolve it: install, locate an existing install, or
 * re-check after doing either.
 */
export function JuliaSetupDialog() {
  const status = useJuliaStore((s) => s.status);
  const version = useJuliaStore((s) => s.version);
  const error = useJuliaStore((s) => s.error);
  const setupOpen = useJuliaStore((s) => s.setupOpen);
  const setSetupOpen = useJuliaStore((s) => s.setSetupOpen);
  const detect = useJuliaStore((s) => s.detect);
  const locateManually = useJuliaStore((s) => s.locateManually);

  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!setupOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSetupOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [setupOpen, setSetupOpen]);

  if (!setupOpen) return null;

  // Branch on "found" rather than "missing": during a re-check the status is
  // transiently "detecting", and treating that as found would flash the package
  // list with an empty version string.
  const juliaReady = status === "found";

  const runStep = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const installPackage = (pkg: string) =>
    runStep(pkg, async () => {
      // julia_pkg_add streams progress as julia-output events and resolves on exit.
      const done = new Promise<void>((resolve, reject) => {
        let unlisten: (() => void) | null = null;
        void listen<JuliaOutputEvent>("julia-output", (e) => {
          if (e.payload.kind !== "done") return;
          unlisten?.();
          if (e.payload.exit_code === 0) resolve();
          else reject(new Error(`Installing ${pkg} failed — see the Output panel for details.`));
        }).then((fn) => {
          unlisten = fn;
        });
      });
      await invoke("julia_pkg_add", { packageName: pkg });
      await done;
      setMessage(`${pkg} installed.`);
    });

  return (
    <div className="julia-setup-overlay" onClick={() => setSetupOpen(false)}>
      <div
        className="julia-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="julia-setup-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="julia-setup-header">
          {juliaReady ? (
            <CheckCircle2 size={20} className="julia-setup-icon ok" />
          ) : (
            <AlertTriangle size={20} className="julia-setup-icon warn" />
          )}
          <h2 id="julia-setup-title">{juliaReady ? "Julia setup" : "Julia is not set up"}</h2>
        </header>

        {!juliaReady ? (
          <>
            <p className="julia-setup-body">
              julIDE runs your code with a Julia installation on this machine — it does not
              bundle one. Install Julia, or point julIDE at an existing install.
            </p>
            {error && <p className="julia-setup-error">{error}</p>}

            <div className="julia-setup-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={() =>
                  runStep("download", async () => {
                    await openExternal(JULIA_DOWNLOAD_URL);
                    setMessage(
                      "Opened julialang.org. Install Julia (juliaup is the easiest option), then choose Re-check.",
                    );
                  })
                }
                disabled={busy !== null}
              >
                <Download size={14} /> Download Julia
              </button>

              <button
                type="button"
                onClick={() => runStep("locate", locateManually)}
                disabled={busy !== null}
              >
                <FolderSearch size={14} />
                {busy === "locate" ? "Checking…" : "Locate manually…"}
              </button>

              <button
                type="button"
                onClick={() => runStep("recheck", detect)}
                disabled={busy !== null}
              >
                <RefreshCw size={14} />
                {busy === "recheck" || status === "detecting" ? "Checking…" : "Re-check"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="julia-setup-body">
              Found <strong>{version}</strong>. These optional packages unlock the rest of
              julIDE — install any you want now, or skip and add them later.
            </p>

            <ul className="julia-setup-packages">
              {OPTIONAL_PACKAGES.map((pkg) => (
                <li key={pkg.name} className="julia-setup-package">
                  <div>
                    <span className="julia-setup-package-name">{pkg.name}.jl</span>
                    <span className="julia-setup-package-unlocks">{pkg.unlocks}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => installPackage(pkg.name)}
                    disabled={busy !== null}
                  >
                    {busy === pkg.name ? "Installing…" : "Install"}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {message && <p className="julia-setup-message">{message}</p>}

        <footer className="julia-setup-footer">
          <button type="button" onClick={() => setSetupOpen(false)}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
