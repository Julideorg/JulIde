import { cloneElement, isValidElement, useEffect, useId } from "react";
import type { ReactElement, ReactNode } from "react";
import { AlertTriangle, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useIdeStore } from "../../stores/useIdeStore";
import { lspClient } from "../../lsp/LspClient";
import { lspStartOptions } from "../../lsp/lspConfig";
import { useModalA11y } from "../../hooks/useModalA11y";
import { Select } from "../ui";
import { containerSupported } from "../../services/containerSupport";
import { setZoom, ZOOM_STEPS, zoomLabel } from "../../services/zoom";
import { PluginSettings } from "./PluginSettings";
import { GitAuthSettings } from "../Git/GitAuthSettings";
import { useAscii } from "../../services/ascii";

export function SettingsPanel() {
  const open = useSettingsStore((s) => s.settingsOpen);
  const setOpen = useSettingsStore((s) => s.setSettingsOpen);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const saveError = useSettingsStore((s) => s.saveError);
  const resetSettings = useSettingsStore((s) => s.resetSettings);
  const flushSettings = useSettingsStore((s) => s.flushSettings);
  const panelRef = useModalA11y<HTMLDivElement>(open);
  const titleId = useId();
  const ascii = useAscii();
  const workspacePath = useIdeStore((s) => s.workspacePath);

  /**
   * Switch language server backends and restart onto the new one.
   *
   * The debounced write has to land first: the Rust side reads the backend from
   * settings.json when it starts a server, so restarting before the flush would
   * bring the old one straight back up.
   */
  const switchBackend = async (backend: string) => {
    await updateSettings({ lspBackend: backend });
    await flushSettings();
    if (!workspacePath) return;
    const settingsNow = useSettingsStore.getState().settings;
    try {
      await lspClient.restart(workspacePath, lspStartOptions(settingsNow));
    } catch (e) {
      console.error("Failed to restart the language server:", e);
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) setOpen(false);
      // Cmd+, to open settings
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setOpen(!open);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, setOpen]);

  // Writes are debounced, so closing right after a change would otherwise drop it.
  useEffect(() => {
    if (!open) void flushSettings();
  }, [open, flushSettings]);

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={() => setOpen(false)}>
      <div
        ref={panelRef}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <h2 id={titleId}>Settings</h2>
          <button
            className="settings-close"
            onClick={() => setOpen(false)}
            aria-label="Close settings"
          >
            <X size={16} />
          </button>
        </div>

        {saveError && (
          <div className="settings-save-error" role="alert">
            <AlertTriangle size={14} />
            <span>Settings could not be saved: {saveError}</span>
          </div>
        )}

        <div className="settings-body">
          <SettingsSection title="Editor">
            <SettingRow label="Font Size">
              <input
                type="number"
                className="settings-input settings-number"
                value={settings.fontSize}
                min={8}
                max={32}
                onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })}
              />
            </SettingRow>

            <SettingRow label="Font Family">
              <input
                type="text"
                className="settings-input"
                value={settings.fontFamily}
                onChange={(e) => updateSettings({ fontFamily: e.target.value })}
              />
            </SettingRow>

            <SettingRow label="Tab Size">
              <input
                type="number"
                className="settings-input settings-number"
                value={settings.tabSize}
                min={1}
                max={8}
                onChange={(e) => updateSettings({ tabSize: Number(e.target.value) })}
              />
            </SettingRow>

            <SettingRow label="Word Wrap">
              <Select
                className="settings-select"
                value={settings.wordWrap}
                onChange={(wordWrap) => updateSettings({ wordWrap })}
                options={[
                  { value: "off", label: "Off" },
                  { value: "on", label: "On" },
                  { value: "wordWrapColumn", label: "Word Wrap Column" },
                  { value: "bounded", label: "Bounded" },
                ]}
              />
            </SettingRow>

            <SettingRow label="Minimap">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.minimapEnabled}
                  onChange={(e) => updateSettings({ minimapEnabled: e.target.checked })}
                />
                <span className="settings-toggle-label">
                  {settings.minimapEnabled ? "Enabled" : "Disabled"}
                </span>
              </label>
            </SettingRow>

            <SettingRow label="Auto Save">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.autoSave}
                  onChange={(e) => updateSettings({ autoSave: e.target.checked })}
                />
                <span className="settings-toggle-label">
                  {settings.autoSave ? "Enabled" : "Disabled"}
                </span>
              </label>
            </SettingRow>
          </SettingsSection>

          <SettingsSection title="Terminal">
            <SettingRow label="Font Size">
              <input
                type="number"
                className="settings-input settings-number"
                value={settings.terminalFontSize}
                min={8}
                max={28}
                onChange={(e) => updateSettings({ terminalFontSize: Number(e.target.value) })}
              />
            </SettingRow>
          </SettingsSection>

          <SettingsSection title="Appearance">
            <SettingRow label="Theme">
              <Select
                className="settings-select"
                value={settings.theme}
                onChange={(theme) => updateSettings({ theme })}
                options={[
                  { value: "julide-dark", label: "julIDE Ink (dark)" },
                  { value: "julide-light", label: "julIDE Paper (light)" },
                ]}
              />
            </SettingRow>

            <SettingRow label="Zoom">
              <Select
                className="settings-select"
                value={String(settings.uiZoom)}
                // Applied through the zoom service, not updateSettings: the webview has
                // to be rescaled as well as the value stored.
                onChange={(value) => void setZoom(Number(value))}
                options={ZOOM_STEPS.map((step) => ({
                  value: String(step),
                  label: zoomLabel(step),
                }))}
              />
              <span className="settings-hint">
                Scales the whole interface, editor and terminal included
              </span>
            </SettingRow>

            <SettingRow label="Activity Bar Labels">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.activityBarLabels}
                  onChange={(e) => updateSettings({ activityBarLabels: e.target.checked })}
                />
                <span className="settings-toggle-label">
                  {settings.activityBarLabels ? "Icons and labels" : "Icons only"}
                </span>
              </label>
              <span className="settings-hint">Labels make views easier to find</span>
            </SettingRow>

            {/*
              Two halves under one switch, because they are one complaint: the chrome's
              typographic punctuation, and the editor's ligatures — which are what draw
              `!=` as a not-equals sign even though the file on disk is plain ASCII.
              Content julIDE did not write is never folded; see src/services/ascii.ts.
            */}
            <SettingRow label="ASCII Only">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.asciiOnly}
                  onChange={(e) => updateSettings({ asciiOnly: e.target.checked })}
                />
                <span className="settings-toggle-label">
                  {settings.asciiOnly ? "ASCII" : "Unicode"}
                </span>
              </label>
              <span className="settings-hint">
                Plain ASCII punctuation in julIDE's own text, and no <code>!=</code> or{" "}
                <code>-&gt;</code> ligatures in the editor. Your files, terminal output and Julia's
                Unicode identifiers are untouched. The application menu follows on next launch.
              </span>
            </SettingRow>

            <SettingRow label="Start Maximized">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.startMaximized}
                  onChange={(e) => updateSettings({ startMaximized: e.target.checked })}
                />
                <span className="settings-toggle-label">
                  {settings.startMaximized ? "Maximized" : "Windowed"}
                </span>
              </label>
              <span className="settings-hint">Takes effect on next launch</span>
            </SettingRow>

            {/*
              Both default off. julIDE's markdown preview renders no images at all
              otherwise — see src/markdown/renderer.ts. Neither toggle widens the CSP:
              bytes are read in Rust and handed over as a blob. They are two settings
              rather than one because the risks are not comparable.
            */}
            <SettingRow label="Workspace Images">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.allowLocalImages}
                  onChange={(e) => updateSettings({ allowLocalImages: e.target.checked })}
                />
                <span className="settings-toggle-label">
                  {settings.allowLocalImages ? "Shown" : "Hidden"}
                </span>
              </label>
              <span className="settings-hint">
                Show images stored in the open workspace. No network access; files outside the
                workspace are still refused.
              </span>
            </SettingRow>

            <SettingRow label="Remote Images">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.allowRemoteImages}
                  onChange={(e) => updateSettings({ allowRemoteImages: e.target.checked })}
                />
                <span className="settings-toggle-label">
                  {settings.allowRemoteImages ? "Shown" : "Hidden"}
                </span>
              </label>
              <span className="settings-hint">
                Fetch <code>https://</code> images such as README badges. Whoever hosts an image
                learns your IP address and when you opened the file.
              </span>
            </SettingRow>
          </SettingsSection>

          <SettingsSection title="Julia">
            <SettingRow label="Language Server">
              <Select
                className="settings-select"
                value={settings.lspBackend}
                onChange={(backend) => void switchBackend(backend)}
                options={[
                  { value: "fatou", label: "Fatou (built-in)" },
                  { value: "languageserver", label: "LanguageServer.jl" },
                  { value: "jetls", label: "JETLS.jl (Experimental)" },
                ]}
              />
              {settings.lspBackend === "fatou" && (
                <span className="settings-hint">
                  {ascii("Built in — nothing to install, and it does not need Julia.")} Fatou
                  analyses source text rather than running it, so it cannot offer types or symbols
                  from installed packages; choose LanguageServer.jl if you need those.
                </span>
              )}
              {settings.lspBackend === "jetls" && (
                <span className="settings-hint">
                  JETLS.jl requires Julia 1.12.2+. See{" "}
                  <a
                    href="https://github.com/aviatesk/JETLS.jl"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "var(--accent)" }}
                  >
                    github.com/aviatesk/JETLS.jl
                  </a>{" "}
                  for installation instructions.
                </span>
              )}
            </SettingRow>

            {settings.lspBackend === "fatou" && (
              <>
                <SettingRow label="Format Line Width">
                  <input
                    type="number"
                    className="settings-input settings-number"
                    value={settings.fatouLineWidth}
                    min={40}
                    max={200}
                    onChange={(e) => updateSettings({ fatouLineWidth: Number(e.target.value) })}
                  />
                  <span className="settings-hint">
                    A <code>fatou.toml</code> in the project overrides this.
                  </span>
                </SettingRow>

                <SettingRow label="Format Indent Width">
                  <input
                    type="number"
                    className="settings-input settings-number"
                    value={settings.fatouIndentWidth}
                    min={1}
                    max={8}
                    onChange={(e) => updateSettings({ fatouIndentWidth: Number(e.target.value) })}
                  />
                </SettingRow>
              </>
            )}

            <SettingRow label="Format on Save">
              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  checked={settings.formatOnSave}
                  onChange={(e) => updateSettings({ formatOnSave: e.target.checked })}
                />
                <span className="settings-checkbox-label">
                  Format the file when you save it explicitly
                </span>
              </label>
            </SettingRow>

            <SettingRow label="Julia Executable Path">
              <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <input
                  type="text"
                  className="settings-input"
                  placeholder="Auto-detect"
                  value={settings.juliaPath}
                  onChange={(e) => {
                    const val = e.target.value;
                    updateSettings({ juliaPath: val });
                    invoke("julia_set_path", { path: val }).catch(() => {});
                  }}
                />
                <button
                  className="settings-browse-btn"
                  onClick={async () => {
                    const path = await invoke<string | null>("dialog_pick_executable");
                    if (path) {
                      await updateSettings({ juliaPath: path });
                      invoke("julia_set_path", { path }).catch(() => {});
                    }
                  }}
                >
                  Browse
                </button>
              </div>
              <span className="settings-hint">Leave empty to auto-detect</span>
            </SettingRow>

            <SettingRow label="Pluto Port">
              <input
                type="number"
                className="settings-input settings-number"
                value={settings.plutoPort}
                min={1024}
                max={65535}
                onChange={(e) => updateSettings({ plutoPort: Number(e.target.value) })}
              />
            </SettingRow>
          </SettingsSection>

          {/* Hidden in the Flatpak build, where no container runtime is reachable. */}
          {containerSupported() && (
            <SettingsSection title="Containers">
              <SettingRow label="Runtime">
                <Select
                  className="settings-select"
                  value={settings.containerRuntime}
                  onChange={(containerRuntime) => updateSettings({ containerRuntime })}
                  options={[
                    { value: "auto", label: "Auto Detect" },
                    { value: "docker", label: "Docker" },
                    { value: "podman", label: "Podman" },
                  ]}
                />
              </SettingRow>

              <SettingRow label="Remote Host">
                <input
                  type="text"
                  className="settings-input"
                  placeholder="ssh://user@host (optional)"
                  value={settings.containerRemoteHost}
                  onChange={(e) => updateSettings({ containerRemoteHost: e.target.value })}
                  title="SSH connection address (not a password). Auth uses SSH keys via ssh-agent."
                />
                <span className="settings-hint">
                  {ascii("Uses SSH key auth — never stores passwords")}
                </span>
              </SettingRow>

              <SettingRow label="Auto-detect devcontainer.json">
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={settings.containerAutoDetect}
                    onChange={(e) => updateSettings({ containerAutoDetect: e.target.checked })}
                  />
                  <span className="settings-toggle-label">
                    {settings.containerAutoDetect ? "Enabled" : "Disabled"}
                  </span>
                </label>
              </SettingRow>

              <SettingRow label="Display Forwarding (X11)">
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={settings.displayForwarding}
                    onChange={(e) => updateSettings({ displayForwarding: e.target.checked })}
                  />
                  <span className="settings-toggle-label">
                    {settings.displayForwarding ? "Enabled" : "Disabled"}
                  </span>
                </label>
              </SettingRow>

              <SettingRow label="GPU Passthrough">
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={settings.gpuPassthrough}
                    onChange={(e) => updateSettings({ gpuPassthrough: e.target.checked })}
                  />
                  <span className="settings-toggle-label">
                    {settings.gpuPassthrough ? "Enabled (GLMakie)" : "Disabled"}
                  </span>
                </label>
              </SettingRow>

              <SettingRow label="SELinux :Z Label">
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={settings.selinuxLabel}
                    onChange={(e) => updateSettings({ selinuxLabel: e.target.checked })}
                  />
                  <span className="settings-toggle-label">
                    {settings.selinuxLabel ? "Auto (Fedora/RHEL)" : "Disabled"}
                  </span>
                </label>
              </SettingRow>

              <SettingRow label="Persist Julia Packages">
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={settings.persistJuliaPackages}
                    onChange={(e) => updateSettings({ persistJuliaPackages: e.target.checked })}
                  />
                  <span className="settings-toggle-label">
                    {settings.persistJuliaPackages ? "Enabled (~/.julia volume)" : "Disabled"}
                  </span>
                </label>
              </SettingRow>
            </SettingsSection>
          )}

          <GitAuthSettings />

          <PluginSettings />
        </div>

        <div className="settings-footer">
          <button
            type="button"
            className="settings-reset"
            onClick={() => void resetSettings()}
            title="Restore every preference to its default. Recent projects are kept."
            aria-label="Restore every preference to its default. Recent projects are kept."
          >
            Reset to defaults
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{title}</h3>
      {children}
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  // Associates the label with whatever control it wraps, so clicking the label
  // focuses the input and screen readers announce the field rather than a blank one.
  const id = useId();
  return (
    <div className="settings-row">
      <label className="settings-label" htmlFor={id}>
        {label}
      </label>
      <div className="settings-control">
        {isValidElement(children)
          ? cloneElement(children as ReactElement<{ id?: string }>, { id })
          : children}
      </div>
    </div>
  );
}
