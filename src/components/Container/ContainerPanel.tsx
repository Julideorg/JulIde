import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { startDevcontainer } from "../../services/devcontainer";
import {
  Container,
  Play,
  Square,
  RefreshCw,
  Trash2,
  ChevronDown,
  ChevronRight,
  AlertCircle,
} from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import type { ContainerInfo } from "../../types";

export function ContainerPanel() {
  const workspacePath = useIdeStore((s) => s.workspacePath);
  const containerState = useIdeStore((s) => s.containerState);
  const containerMode = useIdeStore((s) => s.containerMode);
  const containerName = useIdeStore((s) => s.containerName);
  const devcontainerDetected = useIdeStore((s) => s.devcontainerDetected);
  const devcontainerConfig = useIdeStore((s) => s.devcontainerConfig);
  const containerRuntime = useIdeStore((s) => s.containerRuntime);
  const setActiveBottomPanel = useIdeStore((s) => s.setActiveBottomPanel);
  const appendContainerLog = useIdeStore((s) => s.appendContainerLog);
  const clearContainerLogs = useIdeStore((s) => s.clearContainerLogs);
  const settings = useSettingsStore((s) => s.settings);

  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [containersExpanded, setContainersExpanded] = useState(false);
  const [runtimeDetected, setRuntimeDetected] = useState(false);

  // Detect runtime on mount
  useEffect(() => {
    invoke("container_detect_runtime", {
      preferred: settings.containerRuntime,
      remoteHost: settings.containerRemoteHost || null,
    })
      .then((rt: unknown) => {
        const config = rt as { kind: string };
        useIdeStore.getState().setContainerRuntime(config.kind);
        setRuntimeDetected(true);
        setError("");
      })
      .catch(() => {
        setRuntimeDetected(false);
        setError("");
      });
  }, [settings.containerRuntime, settings.containerRemoteHost]);

  const refreshContainers = useCallback(async () => {
    if (!runtimeDetected) return;
    try {
      const list = await invoke<ContainerInfo[]>("container_list");
      setContainers(list);
    } catch (e) {
      console.error("Failed to list containers:", e);
    }
  }, [runtimeDetected]);

  useEffect(() => {
    if (containersExpanded) refreshContainers();
  }, [containersExpanded, refreshContainers]);

  const handleOpenInContainer = async () => {
    if (!workspacePath) return;
    setLoading(true);
    setError("");
    clearContainerLogs();
    setActiveBottomPanel("container-logs");
    try {
      await startDevcontainer(workspacePath, {
        displayForwarding: settings.displayForwarding,
        gpuPassthrough: settings.gpuPassthrough,
        selinuxLabel: settings.selinuxLabel,
        persistJuliaPackages: settings.persistJuliaPackages,
      });
    } catch (e) {
      setError(String(e));
      appendContainerLog({ kind: "stderr", text: `Error: ${e}` });
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    try {
      await invoke("devcontainer_stop");
    } catch (e) {
      setError(String(e));
    }
  };

  const handleRebuild = async () => {
    if (!workspacePath) return;
    setLoading(true);
    setError("");
    clearContainerLogs();
    setActiveBottomPanel("container-logs");
    try {
      await startDevcontainer(
        workspacePath,
        {
          displayForwarding: settings.displayForwarding,
          gpuPassthrough: settings.gpuPassthrough,
          selinuxLabel: settings.selinuxLabel,
          persistJuliaPackages: settings.persistJuliaPackages,
        },
        "rebuild",
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleDown = async () => {
    try {
      await invoke("devcontainer_down");
    } catch (e) {
      setError(String(e));
    }
  };

  const handleContainerAction = async (
    action: "start" | "stop" | "restart" | "remove",
    id: string
  ) => {
    try {
      if (action === "remove") {
        await invoke("container_remove", { containerId: id });
      } else if (action === "start") {
        await invoke("container_start", { containerId: id });
      } else if (action === "stop") {
        await invoke("container_stop", { containerId: id });
      } else {
        await invoke("container_restart", { containerId: id });
      }
      refreshContainers();
    } catch (e) {
      setError(String(e));
    }
  };

  const statusBadge = (state: string) => {
    const cls =
      state === "running"
        ? "container-badge-running"
        : state === "building" || state === "starting"
        ? "container-badge-building"
        : state === "exited" || state === "stopped"
        ? "container-badge-stopped"
        : "container-badge-other";
    return <span className={`container-badge ${cls}`}>{state}</span>;
  };

  return (
    <div className="container-panel">
      <div className="container-panel-header">
        <Container size={13} />
        <span className="container-panel-title">
          {containerRuntime
            ? containerRuntime.charAt(0).toUpperCase() + containerRuntime.slice(1)
            : "Containers"}
        </span>
        {runtimeDetected && (
          <button
            className="container-refresh-btn"
            onClick={refreshContainers}
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        )}
      </div>

      {error && (
        <div className="container-error">
          <AlertCircle size={12} />
          <span>{error}</span>
        </div>
      )}

      {!runtimeDetected && (
        <div className="container-empty">
          No container runtime detected. Install Docker or Podman to use dev
          containers.
        </div>
      )}

      {runtimeDetected && devcontainerDetected && (
        <div className="container-section">
          <div className="container-section-header">
            <span>Dev Container</span>
            {containerMode && statusBadge(containerState)}
          </div>

          {devcontainerConfig && (
            <div className="container-config-summary">
              {devcontainerConfig.name && (
                <div className="container-config-row">
                  <span className="container-config-label">Name:</span>
                  <span className="container-config-value">
                    {devcontainerConfig.name}
                  </span>
                </div>
              )}
              {devcontainerConfig.image && (
                <div className="container-config-row">
                  <span className="container-config-label">Image:</span>
                  <span className="container-config-value">
                    {devcontainerConfig.image}
                  </span>
                </div>
              )}
              {devcontainerConfig.build?.dockerfile && (
                <div className="container-config-row">
                  <span className="container-config-label">Dockerfile:</span>
                  <span className="container-config-value">
                    {devcontainerConfig.build.dockerfile}
                  </span>
                </div>
              )}
              {devcontainerConfig.forwardPorts &&
                devcontainerConfig.forwardPorts.length > 0 && (
                  <div className="container-config-row">
                    <span className="container-config-label">Ports:</span>
                    <span className="container-config-value">
                      {devcontainerConfig.forwardPorts.join(", ")}
                    </span>
                  </div>
                )}
            </div>
          )}

          <div className="container-actions">
            {!containerMode ? (
              <button
                className="btn-primary container-action-btn"
                onClick={handleOpenInContainer}
                disabled={loading}
              >
                <Play size={13} />
                {loading ? "Starting..." : "Open in Container"}
              </button>
            ) : (
              <>
                <button
                  className="container-action-btn container-btn-secondary"
                  onClick={handleStop}
                >
                  <Square size={12} /> Stop
                </button>
                <button
                  className="container-action-btn container-btn-secondary"
                  onClick={handleRebuild}
                  disabled={loading}
                >
                  <RefreshCw size={12} /> Rebuild
                </button>
                <button
                  className="container-action-btn container-btn-danger"
                  onClick={handleDown}
                >
                  <Trash2 size={12} /> Remove
                </button>
              </>
            )}
          </div>

          {containerMode && containerName && (
            <div className="container-active-info">
              <span className="container-active-label">Active:</span>
              <span className="container-active-name">{containerName}</span>
            </div>
          )}
        </div>
      )}

      {runtimeDetected && !devcontainerDetected && (
        <div className="container-empty">
          No <code>.devcontainer/devcontainer.json</code> found in workspace.
          Create one to get started.
        </div>
      )}

      {runtimeDetected && (
        <div className="container-section">
          <div
            className="container-section-header container-section-toggle"
            onClick={() => setContainersExpanded(!containersExpanded)}
          >
            {containersExpanded ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )}
            <span>All Containers</span>
            {containers.length > 0 && (
              <span className="container-section-count">
                {containers.length}
              </span>
            )}
          </div>

          {containersExpanded && (
            <div className="container-list">
              {containers.length === 0 && (
                <div className="container-list-empty">No containers found</div>
              )}
              {containers.map((c) => (
                <div key={c.id} className="container-item">
                  <div className="container-item-info">
                    <span className="container-item-name">
                      {c.name || c.id.slice(0, 12)}
                    </span>
                    <span className="container-item-image">{c.image}</span>
                  </div>
                  <div className="container-item-right">
                    {statusBadge(c.state || c.status)}
                    <div className="container-item-actions">
                      {c.state === "running" ? (
                        <button
                          className="container-item-btn"
                          onClick={() => handleContainerAction("stop", c.id)}
                          title="Stop"
                        >
                          <Square size={11} />
                        </button>
                      ) : (
                        <button
                          className="container-item-btn"
                          onClick={() => handleContainerAction("start", c.id)}
                          title="Start"
                        >
                          <Play size={11} />
                        </button>
                      )}
                      <button
                        className="container-item-btn container-item-btn-danger"
                        onClick={() => handleContainerAction("remove", c.id)}
                        title="Remove"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
