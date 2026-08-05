import { useState, useEffect, useCallback } from "react";
import { useIdeStore } from "../../stores/useIdeStore";
import { lspClient } from "../../lsp/LspClient";
import { List, ChevronRight, ChevronDown } from "lucide-react";

interface DocumentSymbol {
  name: string;
  kind: number;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  selectionRange: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  children?: DocumentSymbol[];
}

// LSP SymbolKind → icon label
function symbolKindLabel(kind: number): string {
  switch (kind) {
    case 2:
      return "mod";
    case 5:
      return "class";
    case 6:
      return "fn";
    case 12:
      return "fn";
    case 13:
      return "var";
    case 14:
      return "const";
    case 15:
      return "str";
    case 23:
      return "struct";
    case 26:
      return "type";
    default:
      return "sym";
  }
}

function symbolKindClass(kind: number): string {
  switch (kind) {
    case 2:
      return "outline-kind-module";
    case 5:
    case 23:
    case 26:
      return "outline-kind-type";
    case 6:
    case 12:
      return "outline-kind-function";
    case 13:
    case 14:
    case 15:
      return "outline-kind-variable";
    default:
      return "outline-kind-default";
  }
}

function SymbolNode({
  symbol,
  depth,
  onNavigate,
}: {
  symbol: DocumentSymbol;
  depth: number;
  onNavigate: (line: number, col: number) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = symbol.children && symbol.children.length > 0;

  return (
    <div className="outline-symbol">
      <div
        className="outline-symbol-row"
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onClick={() =>
          onNavigate(
            symbol.selectionRange.start.line + 1,
            symbol.selectionRange.start.character + 1,
          )
        }
      >
        {hasChildren ? (
          <span
            className="outline-toggle"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        ) : (
          <span className="outline-toggle-spacer" />
        )}
        <span className={`outline-kind-badge ${symbolKindClass(symbol.kind)}`}>
          {symbolKindLabel(symbol.kind)}
        </span>
        <span className="outline-symbol-name" title={symbol.name}>
          {symbol.name}
        </span>
      </div>
      {hasChildren && expanded && (
        <div className="outline-children">
          {symbol.children!.map((child, i) => (
            <SymbolNode
              key={`${child.name}-${i}`}
              symbol={child}
              depth={depth + 1}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function OutlinePanel() {
  const activeTabId = useIdeStore((s) => s.activeTabId);
  const openTabs = useIdeStore((s) => s.openTabs);
  const lspStatus = useIdeStore((s) => s.lspStatus);
  const activeTab = openTabs.find((t) => t.id === activeTabId);

  const [symbols, setSymbols] = useState<DocumentSymbol[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchSymbols = useCallback(async () => {
    if (!activeTab?.path.endsWith(".jl") || lspStatus !== "ready") {
      setSymbols([]);
      return;
    }
    setLoading(true);
    try {
      const uri = `file://${activeTab.path}`;
      const result = await lspClient.getDocumentSymbols(uri);
      setSymbols((result as DocumentSymbol[]) ?? []);
    } catch {
      setSymbols([]);
    } finally {
      setLoading(false);
    }
  }, [activeTab?.path, lspStatus]);

  useEffect(() => {
    fetchSymbols();
  }, [fetchSymbols]);

  // Refresh symbols when content changes (debounced)
  useEffect(() => {
    if (!activeTab) return;
    const timer = setTimeout(fetchSymbols, 1000);
    return () => clearTimeout(timer);
  }, [activeTab?.content]); // eslint-disable-line react-hooks/exhaustive-deps -- debounced on content only; fetchSymbols changes identity every render

  const navigateToSymbol = useCallback((line: number, col: number) => {
    const editor = useIdeStore.getState().editorInstance;
    if (editor) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: col });
      editor.focus();
    }
  }, []);

  if (!activeTab) {
    return (
      <div className="outline-panel">
        <div className="outline-empty">No file open</div>
      </div>
    );
  }

  if (!activeTab.path.endsWith(".jl")) {
    return (
      <div className="outline-panel">
        <div className="outline-empty">Outline available for Julia files</div>
      </div>
    );
  }

  if (lspStatus !== "ready") {
    return (
      <div className="outline-panel">
        <div className="outline-empty">Waiting for LSP...</div>
      </div>
    );
  }

  return (
    <div className="outline-panel">
      <div className="outline-header">
        <List size={14} />
        <span>Outline</span>
        <button
          className="outline-refresh-btn"
          onClick={fetchSymbols}
          title="Refresh"
          aria-label="Refresh"
        >
          ↻
        </button>
      </div>
      <div className="outline-tree">
        {loading && <div className="outline-loading">Loading...</div>}
        {!loading && symbols.length === 0 && <div className="outline-empty">No symbols found</div>}
        {!loading &&
          symbols.map((sym, i) => (
            <SymbolNode
              key={`${sym.name}-${i}`}
              symbol={sym}
              depth={0}
              onNavigate={navigateToSymbol}
            />
          ))}
      </div>
    </div>
  );
}
