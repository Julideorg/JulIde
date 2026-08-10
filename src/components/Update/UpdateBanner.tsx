import { useEffect } from "react";
import { Download, ExternalLink, RefreshCw, X } from "lucide-react";
import { relaunch } from "@tauri-apps/plugin-process";
import { useUpdateStore } from "../../stores/useUpdateStore";

/**
 * Notifies the user when a new julIDE release is available.
 *
 * The action offered depends on how julIDE was installed. AppImage, macOS, and
 * installed Windows builds can replace themselves; `.deb`/`.rpm` installs are owned
 * by the system package manager, and the Windows portable `.exe` would be updated by
 * running an installer beside it, so those users are pointed at the download page
 * rather than given a button that cannot work.
 */
export function UpdateBanner() {
  const phase = useUpdateStore((s) => s.phase);
  const version = useUpdateStore((s) => s.version);
  const error = useUpdateStore((s) => s.error);
  const progress = useUpdateStore((s) => s.progress);
  const capability = useUpdateStore((s) => s.capability);
  const dismissed = useUpdateStore((s) => s.dismissed);
  const dismiss = useUpdateStore((s) => s.dismiss);
  const checkForUpdate = useUpdateStore((s) => s.check);
  const downloadAndInstall = useUpdateStore((s) => s.downloadAndInstall);
  const openReleasesPage = useUpdateStore((s) => s.openReleasesPage);

  // Check once on startup, quietly. A failure here is routine (offline, feed
  // briefly down) and must not interrupt anyone.
  useEffect(() => {
    void checkForUpdate({ silent: true });
  }, [checkForUpdate]);

  const visible =
    !dismissed && (phase === "available" || phase === "downloading" || phase === "ready");
  if (!visible) return null;

  const canSelfInstall = capability?.canSelfInstall ?? false;

  const percent =
    progress && progress.total ? Math.round((progress.downloaded / progress.total) * 100) : null;

  return (
    <div className="update-banner" role="status">
      <div className="update-banner-text">
        {phase === "available" && (
          <>
            <strong>julIDE {version}</strong> is available.
            {!canSelfInstall && capability?.reason && (
              <span className="update-banner-reason"> {capability.reason}</span>
            )}
          </>
        )}
        {phase === "downloading" && (
          <>
            Downloading {version}
            {percent !== null ? ` — ${percent}%` : "…"}
          </>
        )}
        {phase === "ready" && <>julIDE {version} is installed. Restart to use it.</>}
        {error && <span className="update-banner-error"> {error}</span>}
      </div>

      <div className="update-banner-actions">
        {phase === "available" &&
          (canSelfInstall ? (
            <button type="button" onClick={() => void downloadAndInstall()}>
              <Download size={13} /> Update now
            </button>
          ) : (
            <button type="button" onClick={() => void openReleasesPage()}>
              <ExternalLink size={13} /> Download
            </button>
          ))}

        {phase === "ready" && (
          <button type="button" onClick={() => void relaunch()}>
            <RefreshCw size={13} /> Restart
          </button>
        )}

        <button
          type="button"
          className="update-banner-dismiss"
          onClick={dismiss}
          aria-label="Dismiss update notification"
          title="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
