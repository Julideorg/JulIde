/**
 * Mock for @tauri-apps/api/core — used by Storybook via Vite alias.
 * Returns sensible defaults for common Tauri commands.
 */

const mockResponses: Record<string, any> = {
  settings_load: {
    fontSize: 14,
    fontFamily: "'JetBrains Mono', monospace",
    tabSize: 4,
    minimapEnabled: true,
    wordWrap: "off",
    autoSave: true,
    theme: "julide-dark",
    terminalFontSize: 13,
    recentWorkspaces: ["/home/user/projects/MyProject.jl"],
    containerRuntime: "auto",
    containerRemoteHost: "",
    containerAutoDetect: true,
    displayForwarding: true,
    gpuPassthrough: false,
    selinuxLabel: true,
    persistJuliaPackages: true,
    plutoPort: 3000,
  },
  julia_get_version: "Julia 1.10.4",
  julia_list_environments: ["@v1.10", "@v1.9", "./"],
  git_is_repo: false,
  plugin_scan: [],
  container_detect_runtime: "docker",
};

export async function invoke(command: string, _args?: Record<string, unknown>): Promise<any> {
  if (command in mockResponses) {
    return mockResponses[command];
  }
  return undefined;
}

// Re-export stubs for other plugins that get aliased to this module
export async function open() {}
export async function save() {}
export async function message() {}
export async function ask() {
  return false;
}
export async function confirm() {
  return false;
}
export async function readTextFile() {
  return "";
}
export async function writeTextFile() {}
export async function exists() {
  return false;
}
export class Command {
  static sidecar() {
    return new Command();
  }
  async execute() {
    return { code: 0, stdout: "", stderr: "" };
  }
}
