import { useState, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Search, X, Replace } from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import type { SearchResult, EditorTab } from "../../types";

export function SearchPanel() {
  const workspacePath = useIdeStore((s) => s.workspacePath);
  const searchResults = useIdeStore((s) => s.searchResults);
  const isSearching = useIdeStore((s) => s.isSearching);
  const setSearchResults = useIdeStore((s) => s.setSearchResults);
  const setIsSearching = useIdeStore((s) => s.setIsSearching);
  const openFile = useIdeStore((s) => s.openFile);

  const [query, setQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [replaceMessage, setReplaceMessage] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [fileFilter, setFileFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Normalize file filter: ".jl" or "jl" → "*.jl", leave "*.jl" or "*" as-is
  const normalizeGlob = (filter: string): string | null => {
    const f = filter.trim();
    if (!f) return null;
    if (f.includes("*")) return f;
    if (f.startsWith(".")) return `*${f}`;
    return `*.${f}`;
  };

  const doSearch = useCallback(async () => {
    if (!query.trim() || !workspacePath) return;
    setIsSearching(true);
    try {
      const results = await invoke<SearchResult[]>("fs_search_files", {
        workspace: workspacePath,
        query: query,
        isRegex: useRegex,
        caseSensitive: caseSensitive,
        fileGlob: normalizeGlob(fileFilter),
      });
      setSearchResults(results);
    } catch (e) {
      console.error("Search failed:", e);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [query, workspacePath, useRegex, caseSensitive, fileFilter, setSearchResults, setIsSearching]);

  const doReplace = useCallback(async () => {
    if (!query.trim() || !workspacePath) return;
    setReplaceMessage("");
    try {
      const [filesModified, totalReplacements] = await invoke<[number, number]>(
        "fs_replace_in_files",
        {
          workspace: workspacePath,
          query,
          replacement: replaceQuery,
          isRegex: useRegex,
          caseSensitive,
          fileGlob: normalizeGlob(fileFilter),
        },
      );
      setReplaceMessage(`Replaced ${totalReplacements} occurrences in ${filesModified} files`);
      // Re-run search to update results
      doSearch();
    } catch (e) {
      setReplaceMessage(`Replace failed: ${e}`);
    }
  }, [query, replaceQuery, workspacePath, useRegex, caseSensitive, fileFilter, doSearch]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      doSearch();
    }
  };

  const clearSearch = () => {
    setQuery("");
    setSearchResults([]);
  };

  // Group results by file
  const grouped = useMemo(() => {
    const map = new Map<string, SearchResult[]>();
    for (const r of searchResults) {
      const arr = map.get(r.file) ?? [];
      arr.push(r);
      map.set(r.file, arr);
    }
    return map;
  }, [searchResults]);

  const openResult = async (result: SearchResult) => {
    try {
      const content = await invoke<string>("fs_read_file", { path: result.file });
      const name = result.file.split(/[/\\]/).pop() ?? result.file;
      const tab: EditorTab = {
        id: result.file,
        path: result.file,
        name,
        content,
        isDirty: false,
        language: name.split(".").pop() ?? "plaintext",
      };
      openFile(tab);
      // Focus the editor on the line after a short delay
      setTimeout(() => {
        const editor = useIdeStore.getState().editorInstance;
        if (editor) {
          editor.revealLineInCenter(result.line);
          editor.setPosition({ lineNumber: result.line, column: result.col });
          editor.focus();
        }
      }, 100);
    } catch (e) {
      console.error("Failed to open file:", e);
    }
  };

  const getRelativePath = (filePath: string) => {
    if (workspacePath && filePath.startsWith(workspacePath)) {
      return filePath.slice(workspacePath.length + 1);
    }
    return filePath;
  };

  return (
    <div className="search-panel">
      <div className="search-panel-header">
        <div className="search-input-row">
          <div className="search-input-wrapper">
            <Search size={14} className="search-icon" />
            <input
              ref={inputRef}
              className="search-input"
              placeholder="Search in files..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            {query && (
              <button
                className="search-clear-btn"
                onClick={clearSearch}
                title="Clear"
                aria-label="Clear"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>
        <div className="search-replace-row">
          <button
            className={`search-option-btn ${showReplace ? "active" : ""}`}
            onClick={() => setShowReplace(!showReplace)}
            title="Toggle Replace"
            aria-label="Toggle Replace"
          >
            <Replace size={13} />
          </button>
          {showReplace && (
            <div className="search-replace-input-wrapper">
              <input
                className="search-input search-replace-input"
                placeholder="Replace..."
                value={replaceQuery}
                onChange={(e) => setReplaceQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") doReplace();
                }}
              />
              <button
                className="search-replace-btn"
                onClick={doReplace}
                disabled={!query.trim() || searchResults.length === 0}
                title="Replace All"
                aria-label="Replace All"
              >
                Replace All
              </button>
            </div>
          )}
        </div>
        {replaceMessage && <div className="search-replace-message">{replaceMessage}</div>}
        <div className="search-options">
          <button
            className={`search-option-btn ${caseSensitive ? "active" : ""}`}
            onClick={() => setCaseSensitive(!caseSensitive)}
            title="Match Case"
            aria-label="Match Case"
          >
            Aa
          </button>
          <button
            className={`search-option-btn ${useRegex ? "active" : ""}`}
            onClick={() => setUseRegex(!useRegex)}
            title="Use Regular Expression"
            aria-label="Use Regular Expression"
          >
            .*
          </button>
          <input
            className="search-filter-input"
            placeholder="File filter (e.g. *.jl)"
            value={fileFilter}
            onChange={(e) => setFileFilter(e.target.value)}
          />
        </div>
      </div>

      <div className="search-results">
        {isSearching && <div className="search-status">Searching...</div>}

        {!isSearching && searchResults.length === 0 && query && (
          <div className="search-status">No results found</div>
        )}

        {!isSearching && searchResults.length > 0 && (
          <div className="search-result-count">
            {searchResults.length} results in {grouped.size} files
            {searchResults.length >= 5000 && " (results capped)"}
          </div>
        )}

        {Array.from(grouped.entries()).map(([file, results]) => (
          <SearchFileGroup
            key={file}
            file={file}
            relativePath={getRelativePath(file)}
            results={results}
            onClickResult={openResult}
          />
        ))}
      </div>
    </div>
  );
}

function SearchFileGroup({
  file,
  relativePath,
  results,
  onClickResult,
}: {
  file: string;
  relativePath: string;
  results: SearchResult[];
  onClickResult: (r: SearchResult) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="search-file-group">
      <div className="search-file-header" onClick={() => setCollapsed(!collapsed)}>
        <span className="search-file-toggle">{collapsed ? "▶" : "▼"}</span>
        <span className="search-file-name">{relativePath.split(/[/\\]/).pop()}</span>
        <span className="search-file-path">{relativePath}</span>
        <span className="search-file-count">{results.length}</span>
      </div>
      {!collapsed && (
        <div className="search-file-matches">
          {results.map((r, i) => (
            <div
              key={`${file}:${r.line}:${i}`}
              className="search-match-item"
              onClick={() => onClickResult(r)}
            >
              <span className="search-match-line">{r.line}</span>
              <span className="search-match-text">
                <HighlightedText text={r.text} match={r.match_text} />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HighlightedText({ text, match }: { text: string; match: string }) {
  const idx = text.indexOf(match);
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span className="search-highlight">{match}</span>
      {text.slice(idx + match.length)}
    </>
  );
}
