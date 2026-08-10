import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type * as Monaco from "monaco-editor";
import { parseJupytext } from "../../../notebook/jupytext";
import { useNotebookStore } from "../../../stores/useNotebookStore";
import { NotebookCellLayer, type CellPortal } from "./cellZones";
import { CellOutputView } from "./CellOutputView";

/** Re-parse at most this often while typing. Cheap, but not per-keystroke cheap. */
const SYNC_DEBOUNCE_MS = 150;

/**
 * Owns the cell layer for one editor and renders each cell's output into its zone.
 *
 * The layer is handed to the caller through `onLayer` from inside the effect that
 * creates it, rather than returned. Returning it would mean either a ref read during
 * render — stale on exactly the render after mount, so the toolbar buttons would never
 * find a layer — or a `setState` in an effect purely to round-trip a value the effect
 * already has. The callback is both correct and simpler.
 */
export function useCellLayer(
  editor: Monaco.editor.IStandaloneCodeEditor | null,
  enabled: boolean,
  onLayer: (layer: NotebookCellLayer | null) => void,
): { portals: React.ReactNode } {
  const [portals, setPortals] = useState<CellPortal[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Kept in a ref so the effect does not re-run when the caller passes a new closure.
  const onLayerRef = useRef(onLayer);
  useEffect(() => {
    onLayerRef.current = onLayer;
  });

  useEffect(() => {
    if (!editor || !enabled) {
      onLayerRef.current(null);
      return;
    }
    const layer = new NotebookCellLayer(editor, setPortals);
    onLayerRef.current(layer);
    layer.sync();

    const scheduleSync = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => layer.sync(), SYNC_DEBOUNCE_MS);
    };

    const onChange = editor.onDidChangeModelContent(scheduleSync);
    const onModel = editor.onDidChangeModel(scheduleSync);

    // Zones appear and disappear as outputs arrive, so the layer has to re-sync on
    // store writes too — not only on edits.
    const unsubscribe = useNotebookStore.subscribe(() => {
      const model = editor.getModel();
      if (model) layer.sync(parseJupytext(model.getValue()));
    });

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      onChange.dispose();
      onModel.dispose();
      unsubscribe();
      layer.dispose();
      onLayerRef.current(null);
      setPortals([]);
    };
  }, [editor, enabled]);

  return {
    portals: portals.map((p) => createPortal(<CellOutputView cellId={p.cellId} />, p.host)),
  };
}
