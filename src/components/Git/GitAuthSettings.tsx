import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Trash2, Eye, EyeOff } from "lucide-react";
import type { AuthAccount } from "../../types/git";

const PROVIDERS = [
  { id: "github", label: "GitHub", placeholder: "ghp_..." },
  { id: "gitlab", label: "GitLab", placeholder: "glpat-..." },
  { id: "gitea", label: "Gitea", placeholder: "token..." },
];

export function GitAuthSettings() {
  const [accounts, setAccounts] = useState<AuthAccount[]>([]);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");

  const refresh = async () => {
    try {
      const accs = await invoke<AuthAccount[]>("git_auth_list_accounts");
      setAccounts(accs);
    } catch {
      // git_auth commands may not be available yet
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const saveToken = async (provider: string) => {
    const token = tokens[provider];
    if (!token?.trim()) return;
    setSaving((s) => ({ ...s, [provider]: true }));
    try {
      await invoke("git_auth_save_token", { provider, token: token.trim() });
      setTokens((t) => ({ ...t, [provider]: "" }));
      setError("");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving((s) => ({ ...s, [provider]: false }));
    }
  };

  const removeToken = async (provider: string) => {
    try {
      await invoke("git_auth_remove_token", { provider });
      setError("");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const hasToken = (provider: string) =>
    accounts.find((a) => a.provider === provider)?.hasToken ?? false;

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Git Providers</h3>
      <p className="settings-hint" style={{ marginBottom: 8 }}>
        Configure Personal Access Tokens for GitHub, GitLab, and Gitea integration.
      </p>

      {error && (
        <div className="git-error" style={{ marginBottom: 8 }}>
          {error}
        </div>
      )}

      {PROVIDERS.map((prov) => (
        <div key={prov.id} className="settings-row" style={{ alignItems: "center" }}>
          <label className="settings-label" style={{ minWidth: 60 }}>
            {prov.label}
          </label>
          <div
            className="settings-control"
            style={{ display: "flex", gap: 4, alignItems: "center", flex: 1 }}
          >
            {hasToken(prov.id) ? (
              <>
                <span className="settings-plugin-active" style={{ fontSize: 12 }}>
                  <Check size={12} /> Connected
                </span>
                <button
                  className="git-file-action"
                  onClick={() => removeToken(prov.id)}
                  title="Remove token"
                  aria-label="Remove token"
                >
                  <Trash2 size={12} />
                </button>
              </>
            ) : (
              <>
                <div style={{ position: "relative", flex: 1 }}>
                  <input
                    className="settings-input"
                    type={visible[prov.id] ? "text" : "password"}
                    placeholder={prov.placeholder}
                    value={tokens[prov.id] || ""}
                    onChange={(e) => setTokens((t) => ({ ...t, [prov.id]: e.target.value }))}
                    onKeyDown={(e) => e.key === "Enter" && saveToken(prov.id)}
                    style={{ paddingRight: 28 }}
                  />
                  <button
                    className="git-file-action"
                    onClick={() => setVisible((v) => ({ ...v, [prov.id]: !v[prov.id] }))}
                    style={{
                      position: "absolute",
                      right: 4,
                      top: "50%",
                      transform: "translateY(-50%)",
                    }}
                    title={visible[prov.id] ? "Hide" : "Show"}
                  >
                    {visible[prov.id] ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                </div>
                <button
                  className="btn-primary"
                  onClick={() => saveToken(prov.id)}
                  disabled={!tokens[prov.id]?.trim() || saving[prov.id]}
                  style={{ fontSize: 12, padding: "2px 8px" }}
                >
                  Save
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
