import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Plus, Trash2, RefreshCw } from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import type { JuliaOutputEvent } from "../../types";

interface Package {
  name: string;
  version: string;
}

function parseProjectToml(content: string): Package[] {
  const packages: Package[] = [];
  let inDeps = false;
  for (const line of content.split("\n")) {
    if (line.trim() === "[deps]") {
      inDeps = true;
      continue;
    }
    if (line.startsWith("[") && line.trim() !== "[deps]") {
      inDeps = false;
    }
    if (inDeps) {
      const match = line.match(/^(\w[\w.]+)\s*=\s*"([^"]+)"/);
      if (match) packages.push({ name: match[1], version: match[2] });
    }
  }
  return packages;
}

export function PackageManager() {
  const workspacePath = useIdeStore((s) => s.workspacePath);
  const [packages, setPackages] = useState<Package[]>([]);
  const [pkgOutput, setPkgOutput] = useState<string[]>([]);
  const [newPkg, setNewPkg] = useState("");
  const [loading, setLoading] = useState(false);

  const loadPackages = useCallback(async () => {
    if (!workspacePath) return;
    const projectToml = `${workspacePath}/Project.toml`;
    try {
      const content = await invoke<string>("fs_read_file", { path: projectToml });
      setPackages(parseProjectToml(content));
    } catch {
      setPackages([]);
    }
  }, [workspacePath]);

  useEffect(() => {
    loadPackages();
  }, [loadPackages]);

  // Listen for Pkg output
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<JuliaOutputEvent>("julia-output", (e) => {
      if (e.payload.kind === "done") {
        setLoading(false);
        loadPackages();
      } else {
        setPkgOutput((prev) => [...prev.slice(-100), e.payload.text]);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [loadPackages]);

  const addPackage = async () => {
    if (!newPkg.trim()) return;
    const name = newPkg.trim();
    setLoading(true);
    setPkgOutput([`Adding ${name}...`]);
    setNewPkg("");
    try {
      await invoke("julia_pkg_add", {
        packageName: name,
        projectPath: workspacePath ?? null,
      });
    } catch (e) {
      setPkgOutput((prev) => [...prev, `Error: ${e}`]);
      setLoading(false);
    }
  };

  const removePackage = async (name: string) => {
    setLoading(true);
    setPkgOutput([`Removing ${name}...`]);
    try {
      await invoke("julia_pkg_rm", {
        packageName: name,
        projectPath: workspacePath ?? null,
      });
    } catch (e) {
      setPkgOutput((prev) => [...prev, `Error: ${e}`]);
      setLoading(false);
    }
  };

  return (
    <div className="package-manager">
      <div className="package-manager-header">
        <h3>Package Manager</h3>
        <span className="pkg-workspace">
          {workspacePath ? workspacePath.split(/[/\\]/).pop() : "No workspace"}
        </span>
        <button onClick={loadPackages} title="Refresh" aria-label="Refresh" disabled={loading}>
          <RefreshCw size={13} className={loading ? "spin" : ""} />
        </button>
      </div>

      <div className="pkg-add-row">
        <input
          className="pkg-input"
          placeholder="Package name..."
          value={newPkg}
          onChange={(e) => setNewPkg(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addPackage()}
          disabled={loading}
        />
        <button
          className="btn-primary pkg-add-btn"
          onClick={addPackage}
          disabled={loading || !newPkg.trim()}
        >
          <Plus size={13} /> Add
        </button>
      </div>

      <div className="pkg-list">
        <div className="pkg-list-header">
          <span>Package</span>
          <span>UUID</span>
        </div>
        {packages.length === 0 ? (
          <div className="pkg-empty">
            {workspacePath ? "No Project.toml found" : "Open a workspace to manage packages"}
          </div>
        ) : (
          packages.map((pkg) => (
            <div key={pkg.name} className="pkg-item">
              <span className="pkg-name">{pkg.name}</span>
              <span className="pkg-version">{pkg.version.slice(0, 8)}...</span>
              <button
                className="pkg-remove"
                title={`Remove ${pkg.name}`}
                onClick={() => removePackage(pkg.name)}
                disabled={loading}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))
        )}
      </div>

      {pkgOutput.length > 0 && (
        <div className="pkg-output">
          {pkgOutput.map((line, i) => (
            <div key={i} className="pkg-output-line">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
