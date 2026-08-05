import { ShieldAlert, ShieldCheck } from "lucide-react";
import { usePluginPermissionStore } from "../../stores/usePluginPermissionStore";
import { PERMISSION_CATALOG } from "../../services/pluginPermissions";

/**
 * Asks the user to approve what a plugin is requesting, before it is loaded.
 *
 * Plugins are unsigned third-party code from `~/.julide/plugins/`. Previously they
 * were activated at startup with no prompt and full access to every Tauri command;
 * this is the gate. Declining means the plugin is not executed at all.
 *
 * Prompts are queued and shown one at a time so several new plugins on first launch
 * do not stack modals on top of each other.
 */
export function PluginConsentDialog() {
  const pending = usePluginPermissionStore((s) => s.queue[0]);
  const resolveNext = usePluginPermissionStore((s) => s.resolveNext);

  if (!pending) return null;

  const highRisk = pending.requested.filter((p) => PERMISSION_CATALOG[p].risk === "high");

  return (
    <div className="plugin-consent-overlay">
      <div
        className="plugin-consent-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="plugin-consent-title"
      >
        <header className="plugin-consent-header">
          {highRisk.length > 0 ? (
            <ShieldAlert size={20} className="plugin-consent-icon warn" />
          ) : (
            <ShieldCheck size={20} className="plugin-consent-icon ok" />
          )}
          <div>
            <h2 id="plugin-consent-title">Allow &ldquo;{pending.displayName}&rdquo;?</h2>
            <p className="plugin-consent-subtitle">
              Plugin <code>{pending.pluginId}</code> v{pending.version} wants these
              permissions.
            </p>
          </div>
        </header>

        <ul className="plugin-consent-permissions">
          {pending.requested.map((permission) => {
            const info = PERMISSION_CATALOG[permission];
            return (
              <li key={permission} className={`plugin-consent-permission ${info.risk}`}>
                <span className="plugin-consent-permission-title">
                  {info.title}
                  {info.risk === "high" && (
                    <span className="plugin-consent-risk-badge">High risk</span>
                  )}
                </span>
                <span className="plugin-consent-permission-desc">{info.description}</span>
              </li>
            );
          })}
        </ul>

        {pending.unknown.length > 0 && (
          <p className="plugin-consent-note">
            It also requests {pending.unknown.length} permission
            {pending.unknown.length === 1 ? "" : "s"} julIDE does not recognise (
            {pending.unknown.join(", ")}). These will be ignored.
          </p>
        )}

        <p className="plugin-consent-note">
          Plugins are unsigned code that runs inside julIDE. Only allow plugins you
          trust. You can revoke this later in Settings &rarr; Plugins.
        </p>

        <footer className="plugin-consent-footer">
          <button type="button" onClick={() => resolveNext(false)} autoFocus>
            Don&rsquo;t allow
          </button>
          <button type="button" className="btn-danger" onClick={() => resolveNext(true)}>
            Allow
          </button>
        </footer>
      </div>
    </div>
  );
}
