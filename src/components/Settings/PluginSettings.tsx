import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pluginHost } from "../../services/pluginHost";
import { usePluginPermissionStore } from "../../stores/usePluginPermissionStore";
import { PERMISSION_CATALOG } from "../../services/pluginPermissions";
import { FolderOpen, Check, X, AlertCircle } from "lucide-react";

export function PluginSettings() {
  const [pluginsDir, setPluginsDir] = useState("");
  const plugins = pluginHost.getPlugins();
  const grants = usePluginPermissionStore((s) => s.grants);
  const revoke = usePluginPermissionStore((s) => s.revoke);

  useEffect(() => {
    invoke<string>("plugin_get_dir").then(setPluginsDir).catch(console.error);
  }, []);

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Extensions</h3>

      <div className="settings-row">
        <label className="settings-label">Plugins directory</label>
        <div className="settings-value" style={{ fontSize: "12px", opacity: 0.7 }}>
          <FolderOpen size={12} style={{ marginRight: 4, verticalAlign: "middle" }} />
          {pluginsDir || "~/.julide/plugins/"}
        </div>
      </div>

      {plugins.length === 0 ? (
        <div className="settings-row" style={{ opacity: 0.5 }}>
          No plugins installed. Place plugin folders in the plugins directory above.
        </div>
      ) : (
        <div className="settings-plugins-list">
          {plugins.map((plugin) => {
            const grant = grants[plugin.name];
            return (
              <div key={plugin.name} className="settings-plugin-item">
                <div className="settings-plugin-info">
                  <span className="settings-plugin-name">{plugin.displayName}</span>
                  <span className="settings-plugin-version">v{plugin.version}</span>
                  {grant && grant.permissions.length > 0 && (
                    <span className="settings-plugin-permissions">
                      {grant.permissions.map((p) => PERMISSION_CATALOG[p]?.title ?? p).join(" · ")}
                    </span>
                  )}
                  {grant && grant.permissions.length === 0 && (
                    <span className="settings-plugin-permissions">No permissions granted</span>
                  )}
                </div>
                <div className="settings-plugin-status">
                  {plugin.error ? (
                    <span className="settings-plugin-error" title={plugin.error}>
                      <AlertCircle size={13} /> Error
                    </span>
                  ) : plugin.active ? (
                    <span className="settings-plugin-active">
                      <Check size={13} /> Active
                    </span>
                  ) : (
                    <span className="settings-plugin-inactive">
                      <X size={13} /> Inactive
                    </span>
                  )}
                  {grant && (
                    // Revoking clears the stored approval; the plugin is re-prompted
                    // on next launch rather than silently keeping its access.
                    <button
                      type="button"
                      className="settings-plugin-revoke"
                      onClick={() => void revoke(plugin.name)}
                      title="Revoke granted permissions — takes effect on next launch"
                      aria-label="Revoke granted permissions — takes effect on next launch"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
