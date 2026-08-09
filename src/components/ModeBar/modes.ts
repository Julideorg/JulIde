import { invoke } from "@tauri-apps/api/core";
import { useIdeStore } from "../../stores/useIdeStore";
import { usePluginStore } from "../../stores/usePluginStore";
import { lspClient } from "../../lsp/LspClient";
import { toast } from "../ui";
import type { Tone } from "../ui";
import { openFileAtPath } from "../../services/openFile";
import { flattenTree, rank } from "./fuzzy";

/**
 * The Mode Bar's grammar is Julia's REPL grammar.
 *
 * Every Julia user already knows that `]` enters package mode, `?` asks for
 * help and `;` drops to the shell — that muscle memory is reused here so one
 * visible entry point reaches everything, instead of a hidden palette per
 * feature. The prompt and accent colour change with the mode exactly as the
 * REPL's do.
 */
export type ModeId =
  "files" | "commands" | "packages" | "lookup" | "shell" | "symbols" | "problems";

export interface ModeResult {
  id: string;
  label: string;
  /** Secondary line: a path, a description, a version. */
  detail?: string;
  /** Right-aligned: a shortcut, a status, a count. */
  hint?: string;
  run: () => void | Promise<void>;
}

export interface Mode {
  id: ModeId;
  /** Character that switches into this mode. Empty string is the default mode. */
  prefix: string;
  /** Shown at the left of the input, REPL-style. */
  prompt: string;
  tone: Tone;
  /** One line, shown in the legend and as the input placeholder. */
  description: string;
  placeholder: string;
  /** Results for the current query (already stripped of the prefix). */
  getResults: (query: string) => ModeResult[] | Promise<ModeResult[]>;
  /** Shown instead of "no results" when the mode can't work right now. */
  unavailable?: () => string | null;
}

function revealPosition(line: number, column: number) {
  const editor = useIdeStore.getState().editorInstance;
  if (!editor) return;
  editor.revealLineInCenter(line);
  editor.setPosition({ lineNumber: line, column });
  editor.focus();
}

/** LSP positions are 0-based; Monaco's are 1-based. */
function toMonaco(pos: { line: number; character: number }) {
  return { line: pos.line + 1, column: pos.character + 1 };
}

interface LspSymbol {
  name: string;
  kind?: number;
  containerName?: string;
  location?: { uri: string; range: { start: { line: number; character: number } } };
  range?: { start: { line: number; character: number } };
  selectionRange?: { start: { line: number; character: number } };
  children?: LspSymbol[];
}

/** LSP SymbolKind -> a short Julia-flavoured label. */
const SYMBOL_KIND: Record<number, string> = {
  2: "module",
  5: "struct",
  6: "method",
  11: "interface",
  12: "function",
  13: "variable",
  14: "const",
  22: "struct",
  23: "struct",
  26: "type",
};

function flattenSymbols(symbols: LspSymbol[], container = ""): LspSymbol[] {
  return symbols.flatMap((s) => [
    { ...s, containerName: s.containerName ?? container },
    ...flattenSymbols(s.children ?? [], s.name),
  ]);
}

export const MODES: Mode[] = [
  {
    id: "files",
    prefix: "",
    prompt: "julia>",
    tone: "brand",
    description: "…or type to find a file",
    placeholder: "Find a file, or press ] ? ; > @ # to switch mode",
    unavailable: () =>
      useIdeStore.getState().workspacePath ? null : "Open a folder to search its files.",
    getResults: (query) => {
      const tree = useIdeStore.getState().fileTree;
      if (!tree) return [];
      const files = rank(query, flattenTree(tree), (f) => f.relativePath);
      return files.map((f) => ({
        id: f.path,
        label: f.name,
        detail: f.relativePath,
        run: () => openFileAtPath(f.path, f.name),
      }));
    },
  },

  {
    id: "commands",
    prefix: ">",
    prompt: "cmd>",
    tone: "brand",
    description: "commands",
    placeholder: "Run a command",
    getResults: (query) => {
      const commands = Array.from(usePluginStore.getState().commands.values());
      return rank(query, commands, (c) => `${c.label} ${c.description ?? ""}`).map((c) => ({
        id: c.id,
        label: c.label,
        detail: c.description,
        hint: c.shortcut,
        run: () => c.execute(),
      }));
    },
  },

  {
    id: "packages",
    prefix: "]",
    prompt: "pkg>",
    tone: "pkg",
    description: "packages",
    placeholder: "add Plots · rm Plots · status",
    unavailable: () =>
      useIdeStore.getState().workspacePath ? null : "Open a folder to manage its environment.",
    getResults: (query) => {
      const workspacePath = useIdeStore.getState().workspacePath ?? null;
      const [verb, ...rest] = query.trim().split(/\s+/);
      const name = rest.join(" ").trim();
      const showPanel = () => useIdeStore.getState().setActiveBottomPanel("packages");

      // Mirrors the Pkg REPL's own verbs, so what users already type works.
      const isAdd = /^a(dd)?$/i.test(verb ?? "");
      const isRemove = /^(rm|remove)$/i.test(verb ?? "");

      if (isAdd && name) {
        return [
          {
            id: `add-${name}`,
            label: `add ${name}`,
            detail: "Install into the active environment",
            hint: "↵ install",
            run: async () => {
              showPanel();
              toast.info("Installing", `Adding ${name} to the environment.`);
              try {
                await invoke("julia_pkg_add", { packageName: name, projectPath: workspacePath });
              } catch (e) {
                toast.error(`Could not add ${name}`, String(e));
              }
            },
          },
        ];
      }

      if (isRemove && name) {
        return [
          {
            id: `rm-${name}`,
            label: `rm ${name}`,
            detail: "Remove from the active environment",
            hint: "↵ remove",
            run: async () => {
              showPanel();
              try {
                await invoke("julia_pkg_rm", { packageName: name, projectPath: workspacePath });
              } catch (e) {
                toast.error(`Could not remove ${name}`, String(e));
              }
            },
          },
        ];
      }

      // No verb yet: teach the grammar rather than showing "no results".
      return [
        {
          id: "hint-add",
          label: "add <package>",
          detail: "Install a package into this environment",
          run: showPanel,
        },
        {
          id: "hint-rm",
          label: "rm <package>",
          detail: "Remove a package from this environment",
          run: showPanel,
        },
        {
          id: "hint-status",
          label: "status",
          detail: "Show the installed packages",
          run: showPanel,
        },
      ];
    },
  },

  {
    id: "lookup",
    prefix: "?",
    prompt: "help?>",
    tone: "help",
    description: "look up a symbol",
    placeholder: "Search functions, structs and modules across the project",
    unavailable: () => (lspClient.isReady ? null : "The language server is still starting."),
    getResults: async (query) => {
      if (!query.trim()) return [];
      const symbols = (await lspClient.getWorkspaceSymbols(query)) as LspSymbol[] | null;
      return (symbols ?? []).slice(0, 50).map((s, i) => {
        const loc = s.location;
        return {
          id: `${s.name}-${i}`,
          label: s.name,
          detail: s.containerName || loc?.uri.replace(/^file:\/\//, ""),
          hint: s.kind ? SYMBOL_KIND[s.kind] : undefined,
          run: async () => {
            if (!loc) return;
            const path = decodeURIComponent(loc.uri.replace(/^file:\/\//, ""));
            await openFileAtPath(path, path.split("/").pop() ?? path);
            const { line, column } = toMonaco(loc.range.start);
            // Let the editor swap models before moving the cursor.
            setTimeout(() => revealPosition(line, column), 60);
          },
        };
      });
    },
  },

  {
    id: "shell",
    prefix: ";",
    prompt: "shell>",
    tone: "shell",
    description: "shell",
    placeholder: "Run a shell command in the active terminal",
    unavailable: () =>
      useIdeStore.getState().activeTerminalId ? null : "No terminal session is running.",
    getResults: (query) => {
      const command = query.trim();
      if (!command) return [];
      return [
        {
          id: "run-shell",
          label: command,
          detail: "Send to the active terminal",
          hint: "↵ run",
          run: async () => {
            const sessionId = useIdeStore.getState().activeTerminalId;
            if (!sessionId) return;
            useIdeStore.getState().setActiveBottomPanel("terminal");
            try {
              await invoke("pty_write", { sessionId, data: command + "\n" });
            } catch (e) {
              toast.error("Could not run command", String(e));
            }
          },
        },
      ];
    },
  },

  {
    id: "symbols",
    prefix: "@",
    prompt: "@",
    tone: "run",
    description: "symbols in this file",
    placeholder: "Jump to a function, struct or module in this file",
    unavailable: () => (useIdeStore.getState().activeTabId ? null : "Open a file first."),
    getResults: async (query) => {
      const state = useIdeStore.getState();
      const tab = state.openTabs.find((t) => t.id === state.activeTabId);
      if (!tab) return [];
      const raw = (await lspClient.getDocumentSymbols(`file://${tab.path}`)) as LspSymbol[] | null;
      const symbols = flattenSymbols(raw ?? []);
      return rank(query, symbols, (s) => s.name).map((s, i) => {
        const start = s.selectionRange?.start ?? s.range?.start ?? s.location?.range.start;
        return {
          id: `${s.name}-${i}`,
          label: s.name,
          detail: s.containerName || undefined,
          hint: s.kind ? SYMBOL_KIND[s.kind] : undefined,
          run: () => {
            if (!start) return;
            const { line, column } = toMonaco(start);
            revealPosition(line, column);
          },
        };
      });
    },
  },

  {
    id: "problems",
    prefix: "#",
    prompt: "#",
    tone: "help",
    description: "problems",
    placeholder: "Jump to an error or warning",
    getResults: (query) => {
      const problems = useIdeStore.getState().problems;
      return rank(query, problems, (p) => `${p.message} ${p.file}`).map((p) => ({
        id: p.id,
        label: p.message,
        detail: `${p.file.split("/").pop()}:${p.line}:${p.col}`,
        hint: p.severity,
        run: async () => {
          await openFileAtPath(p.file, p.file.split("/").pop() ?? p.file);
          setTimeout(() => revealPosition(p.line, p.col), 60);
        },
      }));
    },
  },
];

/** Split raw input into its mode and the query beneath it. */
export function parseInput(raw: string): { mode: Mode; query: string } {
  const prefixed = MODES.filter((m) => m.prefix).find((m) => raw.startsWith(m.prefix));
  if (prefixed) return { mode: prefixed, query: raw.slice(prefixed.prefix.length) };
  return { mode: MODES[0], query: raw };
}
