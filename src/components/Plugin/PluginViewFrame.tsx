import { useEffect, useRef } from "react";
import { pluginHost } from "../../services/pluginHost";
import type { PluginViewRef } from "../../types/plugin";

interface Props {
  view: PluginViewRef;
  label?: string;
}

/**
 * Mounts one sandboxed frame for a plugin view.
 *
 * The frame is created on first mount rather than at startup — a plugin with three
 * declared views only pays for the ones the user opens. That is what the declarative
 * `contributes.views` in the manifest buys: the activity-bar entry and the panel tab
 * exist before any plugin code has run, so there is something to click before there is
 * anything to run.
 *
 * React owns the container; the host owns the frame inside it. The two are kept apart
 * because the frame must survive React re-renders — reloading a plugin's document every
 * time the parent re-renders would restart its work and lose its state.
 */
export function PluginViewFrame({ view, label }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const handle = pluginHost.mountView(view, container);

    return () => {
      // StrictMode double-invokes effects in development. `disposed` keeps the second
      // teardown from destroying a frame the second mount has already replaced.
      disposed = true;
      void handle.then((h) => {
        if (disposed) void h?.destroy();
      });
    };
  }, [view.pluginId, view.viewId]);

  return (
    <div
      ref={containerRef}
      className="plugin-view-container"
      data-plugin={view.pluginId}
      data-view={view.viewId}
      aria-label={label}
    />
  );
}
