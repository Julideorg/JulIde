export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileNode[];
}

export interface EditorTab {
  id: string;
  path: string;
  name: string;
  content: string;
  /**
   * What is believed to be on disk: the bytes as opened, or as last written.
   *
   * `isDirty` is derived from `content !== savedContent` rather than set by whoever
   * happens to be editing, so undoing back to the saved text clears the indicator the
   * way it does in VS Code, and no call site can forget to raise the flag — which is
   * exactly how the tab dot spent its first two releases permanently switched off.
   */
  savedContent: string;
  isDirty: boolean;
  language: string;
  /**
   * Which view this tab renders in. Absent means source, and only markdown tabs offer
   * anything else — optional so the several places that build a tab by hand need no
   * change, and so closing a tab disposes the state with it.
   */
  viewMode?: "source" | "preview";
}

export interface OutputLine {
  id: string;
  kind: "stdout" | "stderr" | "info" | "done";
  text: string;
  timestamp: number;
  /** Rich MIME content (images, HTML, SVG) from Julia display() calls. */
  mime?: { type: string; data: string };
}

export interface Problem {
  id: string;
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface DebugVariable {
  name: string;
  value: string;
  type_name: string;
}

export interface Breakpoint {
  file: string;
  line: number;
}

export interface DebugState {
  isDebugging: boolean;
  isPaused: boolean;
  currentFile: string;
  currentLine: number;
  variables: DebugVariable[];
  callStack: string[];
}

export type ActiveBottomPanel = string;

export interface JuliaOutputEvent {
  kind: "stdout" | "stderr" | "done" | "error";
  text: string;
  exit_code?: number;
}

export interface PtyOutputEvent {
  session_id: string;
  data: string;
}

export interface DebugStoppedEvent {
  file: string;
  line: number;
  reason: string;
}

export interface DebugOutputEvent {
  kind: string;
  text: string;
}

export interface DebugVariablesEvent {
  variables: DebugVariable[];
}

export interface SearchResult {
  file: string;
  line: number;
  col: number;
  text: string;
  match_text: string;
}

export type SidebarView = string;

// ─── Container Types ─────────────────────────────────────────────────────────

export type ContainerState = "none" | "building" | "starting" | "running" | "stopped" | "error";

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  created: string;
}

export interface ContainerStatusEvent {
  status: ContainerState;
  message?: string;
  container_id?: string;
}

export interface ContainerOutputEvent {
  kind: "stdout" | "stderr" | "status" | "done" | "error";
  text: string;
  exit_code?: number;
}

// Re-export plugin types
export type {
  CommandContribution,
  SidebarPanelContribution,
  BottomPanelContribution,
  StatusBarItemContribution,
  ToolbarButtonContribution,
  PluginManifest,
  Disposable,
} from "./plugin";

export interface DevContainerConfig {
  name?: string;
  image?: string;
  build?: {
    dockerfile?: string;
    context?: string;
    args?: Record<string, string>;
    target?: string;
    cacheFrom?: string[];
  };
  dockerComposeFile?: string | string[];
  service?: string;
  workspaceFolder?: string;
  forwardPorts?: number[];
  initializeCommand?: string | string[];
  onCreateCommand?: string | string[];
  updateContentCommand?: string | string[];
  postCreateCommand?: string | string[];
  postStartCommand?: string | string[];
  postAttachCommand?: string | string[];
  remoteUser?: string;
  containerEnv?: Record<string, string>;
  mounts?: (string | Record<string, string>)[];
  features?: Record<string, unknown>;
  runArgs?: string[];
  capAdd?: string[];
  securityOpt?: string[];
  privileged?: boolean;
  shutdownAction?: "none" | "stopContainer";
  customizations?: unknown;
}
