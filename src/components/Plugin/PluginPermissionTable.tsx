import { Globe, WifiOff } from "lucide-react";
import { PERMISSION_CATALOG, type PluginPermission } from "../../services/pluginPermissions";
import { useAscii } from "../../services/ascii";

interface Props {
  permissions: readonly PluginPermission[];
  /** Declared hosts, already validated. Shown as "can send data to". */
  network?: readonly string[];
  /** Permissions this version adds over the installed one. Highlighted. */
  addedSince?: readonly string[];
}

/**
 * The one place `PERMISSION_CATALOG` wording reaches the screen.
 *
 * Shared between the consent dialog and the plugin browser deliberately. If the browser
 * paraphrased — even improved — the wording, a user would read one description while
 * deciding to install and a different one while approving, conclude the dialog is
 * boilerplate, and stop reading it. That is worse than any wording improvement is worth,
 * and a shared component makes the paraphrase structurally impossible rather than a
 * convention someone has to remember.
 */
export function PluginPermissionTable({ permissions, network, addedSince }: Props) {
  const added = new Set(addedSince ?? []);
  // Folded here rather than in PERMISSION_CATALOG: those literals are mirrored into the
  // generated permission-catalog.json, so editing them would force a regeneration and
  // put `check:permission-catalog` at risk of drifting.
  const ascii = useAscii();

  return (
    <>
      {permissions.length > 0 && (
        <ul className="plugin-consent-permissions">
          {permissions.map((permission) => {
            const info = PERMISSION_CATALOG[permission];
            if (!info) return null;
            return (
              <li
                key={permission}
                className={`plugin-consent-permission ${info.risk}${added.has(permission) ? " added" : ""}`}
              >
                <span className="plugin-consent-permission-title">
                  {ascii(info.title)}
                  {info.risk === "high" && (
                    <span className="plugin-consent-risk-badge">High risk</span>
                  )}
                  {added.has(permission) && <span className="plugin-consent-new-badge">New</span>}
                </span>
                <span className="plugin-consent-permission-desc">{ascii(info.description)}</span>
              </li>
            );
          })}
        </ul>
      )}

      {network !== undefined && (
        /*
         * Stated either way. "No network access" is four words, and it is the difference
         * between a user assuming a plugin is offline and knowing it — which is also
         * what makes the host list mean something when one does appear.
         */
        <div className={`plugin-consent-network ${network.length > 0 ? "warn" : "ok"}`}>
          {network.length > 0 ? (
            <>
              <span className="plugin-consent-network-title">
                <Globe size={13} /> Can send data to
              </span>
              <ul className="plugin-consent-network-hosts">
                {network.map((host) => (
                  <li key={host}>
                    <code>{host}</code>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <span className="plugin-consent-network-title">
              <WifiOff size={13} /> No network access
            </span>
          )}
        </div>
      )}
    </>
  );
}

/** Permission titles for a one-line summary. Same source, same words. */
export function permissionTitles(permissions: readonly string[]): string[] {
  return permissions.map((p) => PERMISSION_CATALOG[p as PluginPermission]?.title ?? p);
}
