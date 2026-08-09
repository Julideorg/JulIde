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
  isDirty: boolean;
  language: string;
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
