import { useEffect, useState } from "react";
import { AlertTriangle, Download, Package, RefreshCw, Search, Trash2 } from "lucide-react";
import { useMarketplaceStore } from "../../stores/useMarketplaceStore";
import { pluginHost } from "../../services/pluginHost";
import { formatSize } from "../../services/marketplace";
import { openExternal } from "../../services/openExternal";
import { EmptyState } from "../ui";
import { PluginPermissionTable } from "../Plugin/PluginPermissionTable";
import { iconSize } from "../../themes/tokens";
import type { PluginPermission } from "../../services/pluginPermissions";
import type { RegistryEntry } from "../../types/marketplace";

/**
 * Browse and install plugins from the registry.
 *
 * Two deliberate properties:
 *
 * - **No remote images.** The CSP allows `img-src 'self' data: blob:`, and widening it
 *   for registry icons would widen it for every plugin in the same realm. A glyph and a
 *   letter cost nothing by comparison.
 * - **Two consent surfaces, on purpose.** Expanding a row shows what the plugin will ask
 *   for; installing then triggers julIDE's own consent dialog. Collapsing them would mean
 *   granting at install time, which moves consent off the single choke point in
 *   `pluginHost` and creates a second code path that can hand out permissions.
 */
export function PluginBrowser() {
  const { index, loading, error, query, updates, busy } = useMarketplaceStore();
  const { setQuery, loadIndex, checkUpdates, install, uninstall, results } = useMarketplaceStore();
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    void loadIndex();
    void checkUpdates();
  }, [loadIndex, checkUpdates]);

  const installed = new Set(pluginHost.getPlugins().map((p) => p.name));
  const entries = results();

  return (
    <div className="settings-section">
      <div className="marketplace-header">
        <div className="marketplace-search">
          <Search size={iconSize.xs} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plugins"
            aria-label="Search plugins"
          />
        </div>
        <button
          type="button"
          className="marketplace-refresh"
          onClick={() => void loadIndex(true)}
          disabled={loading}
          title="Refresh the registry index"
          aria-label="Refresh the registry index"
        >
          <RefreshCw size={iconSize.xs} className={loading ? "spinning" : undefined} />
        </button>
      </div>

      {index?.paused && (
        <p className="marketplace-notice warn">
          <AlertTriangle size={iconSize.xs} /> The registry has paused installs. Plugins you already
          have keep working.
        </p>
      )}

      {error && (
        <p className="marketplace-notice warn">
          <AlertTriangle size={iconSize.xs} /> {error}
        </p>
      )}

      {loading && !index ? (
        <EmptyState icon={<Package size={28} />} title="Loading the registry…" />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<Package size={28} />}
          title={query ? "No plugins match that search" : "No plugins available"}
          hint={
            error
              ? "The registry could not be reached or its signature did not verify."
              : "Plugins you install appear under Installed."
          }
        />
      ) : (
        <div className="marketplace-list">
          {entries.map((entry) => (
            <PluginRow
              key={entry.name}
              entry={entry}
              installed={installed.has(entry.name)}
              update={updates.find((u) => u.name === entry.name)}
              busy={busy[entry.name]}
              expanded={expanded === entry.name}
              onToggle={() => setExpanded(expanded === entry.name ? null : entry.name)}
              onInstall={() => void install(entry)}
              onUninstall={() => void uninstall(entry.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface RowProps {
  entry: RegistryEntry;
  installed: boolean;
  update?: { availableVersion: string; permissionsAdded: string[] };
  busy?: string;
  expanded: boolean;
  onToggle: () => void;
  onInstall: () => void;
  onUninstall: () => void;
}

function PluginRow({
  entry,
  installed,
  update,
  busy,
  expanded,
  onToggle,
  onInstall,
  onUninstall,
}: RowProps) {
  const latest = entry.latest;

  return (
    <div className="marketplace-item">
      <button
        type="button"
        className="marketplace-item-head"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        {/* A glyph and a letter, never a remote image — see the component doc. */}
        <span className="marketplace-icon" aria-hidden="true">
          {entry.displayName.charAt(0).toUpperCase()}
        </span>
        <span className="marketplace-item-text">
          <span className="marketplace-item-title">
            {entry.displayName}
            {latest && <span className="marketplace-item-version">v{latest.version}</span>}
            {update && <span className="marketplace-update-badge">Update</span>}
          </span>
          <span className="marketplace-item-desc">{entry.description}</span>
          {/* The registry's own plain-English summary, computed from the same catalog. */}
          <span className={`marketplace-capability ${entry.capability.tier}`}>
            {entry.capability.headline}
          </span>
        </span>
      </button>

      {expanded && (
        <div className="marketplace-item-detail">
          <p className="marketplace-meta">
            {entry.author} · {entry.license}
            {latest && ` · ${formatSize(latest.sizeBytes)}`} ·{" "}
            <a
              href="#"
              onClick={(e) => {
                // Never an href: openExternal validates the scheme, and a registry
                // string is not something to hand straight to the OS.
                e.preventDefault();
                void openExternal(entry.repository);
              }}
            >
              repository
            </a>
          </p>

          {latest && (
            <PluginPermissionTable
              permissions={latest.permissions as PluginPermission[]}
              network={latest.network}
              addedSince={update?.permissionsAdded}
            />
          )}

          <p className="marketplace-note">
            Installing runs someone else&rsquo;s code inside julIDE. You will be asked to approve
            these permissions before it loads.
          </p>

          <div className="marketplace-actions">
            {installed ? (
              <>
                {update && (
                  <button type="button" onClick={onInstall} disabled={!!busy}>
                    <Download size={iconSize.xs} />
                    {busy === "updating" ? "Updating…" : `Update to ${update.availableVersion}`}
                  </button>
                )}
                <button
                  type="button"
                  className="btn-danger"
                  onClick={onUninstall}
                  disabled={!!busy}
                >
                  <Trash2 size={iconSize.xs} />
                  {busy === "uninstalling" ? "Removing…" : "Uninstall"}
                </button>
              </>
            ) : (
              <button type="button" onClick={onInstall} disabled={!!busy || !latest}>
                <Download size={iconSize.xs} />
                {busy === "installing" ? "Installing…" : "Install"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
