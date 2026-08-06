import { useState, useEffect, useRef, useMemo } from "react";
import { Trash2, ChevronLeft, ChevronRight, Maximize2, Minimize2, ChartLine } from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import { EmptyState, Kbd } from "../ui";

// Helper to convert base64 to Blob efficiently using modern browser APIs
function base64ToBlob(base64: string, type: string): Blob {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type });
}

export function PlotPane() {
  // Selector optimization: Only grab output if you must, but filtering it inside useMemo is the key
  const output = useIdeStore((s) => s.output);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [clearedTimestamp, setClearedTimestamp] = useState<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // 1. Optimized filtering: Only recalculate when output array reference changes
  const plotLines = useMemo(() => {
    return output.filter(
      (line) =>
        line.timestamp > clearedTimestamp &&
        line.mime &&
        (line.mime.type.startsWith("image/") || line.mime.type === "text/html"),
    );
  }, [output, clearedTimestamp]);

  // Track active line to prevent unnecessary URL recreations
  const activeLine = plotLines[currentIndex];
  const activeLineKey = activeLine ? `${activeLine.timestamp}-${currentIndex}` : null;

  // State to hold the safely generated object URL
  const [plotData, setPlotData] = useState<{ url: string; type: string } | null>(null);

  // 2. Safely track history length to auto-navigate to newer plots
  const prevLengthRef = useRef(plotLines.length);

  useEffect(() => {
    if (plotLines.length > prevLengthRef.current) {
      setCurrentIndex(plotLines.length - 1);
    } else if (currentIndex >= plotLines.length) {
      setCurrentIndex(Math.max(0, plotLines.length - 1));
    }
    prevLengthRef.current = plotLines.length;
  }, [plotLines.length, currentIndex]);

  // 3. Correct Side-Effect Management for Object URLs
  useEffect(() => {
    if (!activeLine || !activeLine.mime) {
      setPlotData(null);
      return;
    }

    let active = true;
    let objectUrl: string | null = null;

    try {
      const { type, data } = activeLine.mime;
      const blob = base64ToBlob(data, type);
      objectUrl = URL.createObjectURL(blob);

      if (active) {
        setPlotData({ url: objectUrl, type });
      }
    } catch (err) {
      console.error("Failed to process plot data:", err);
      if (active) setPlotData(null);
    }

    // Strict cleanup: Revokes the URL precisely when the active plot changes or unmounts
    return () => {
      active = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [activeLineKey]); // Rely on a specific primitive key instead of object reference

  const clearPlots = () => {
    setClearedTimestamp(Date.now());
    setCurrentIndex(0);
  };

  const goPrev = () => setCurrentIndex((prev) => Math.max(0, prev - 1));
  const goNext = () => setCurrentIndex((prev) => Math.min(plotLines.length - 1, prev + 1));

  return (
    <div className={`plot-pane ${expanded ? "plot-pane-expanded" : ""}`}>
      <div className="plot-pane-toolbar">
        <span className="plot-pane-title">Plots</span>
        {plotLines.length > 0 && (
          <span className="plot-pane-counter">
            {currentIndex + 1} / {plotLines.length}
          </span>
        )}
        <div className="plot-pane-actions">
          <button
            className="plot-pane-btn"
            onClick={goPrev}
            disabled={currentIndex <= 0}
            title="Previous plot"
            aria-label="Previous plot"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            className="plot-pane-btn"
            onClick={goNext}
            disabled={currentIndex >= plotLines.length - 1}
            title="Next plot"
            aria-label="Next plot"
          >
            <ChevronRight size={14} />
          </button>
          <button
            className="plot-pane-btn"
            onClick={() => setExpanded(!expanded)}
            title={expanded ? "Minimize" : "Maximize"}
          >
            {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            className="plot-pane-btn"
            onClick={clearPlots}
            title="Clear plots"
            aria-label="Clear plots"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      <div className="plot-pane-content" ref={containerRef}>
        {plotLines.length === 0 ? (
          <EmptyState
            icon={<ChartLine size={28} />}
            title="Plots appear here"
            hint={
              <>
                Run a file with <Kbd>F5</Kbd>, or a single cell with <Kbd>Ctrl+Enter</Kbd>. Output
                from Plots.jl, Makie.jl and anything else that emits an image or HTML lands in this
                pane.
              </>
            }
          />
        ) : plotData ? (
          <div className="plot-pane-display">
            {plotData.type === "text/html" ? (
              <iframe
                src={plotData.url}
                className="plot-pane-iframe"
                sandbox="allow-scripts"
                title={`HTML Plot ${currentIndex + 1}`}
              />
            ) : (
              <img
                src={plotData.url}
                className="plot-pane-image"
                alt={`Plot ${currentIndex + 1}`}
              />
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
