import type { StorybookConfig } from "@storybook/react-vite";
import path from "path";
import { fileURLToPath } from "node:url";

// Storybook 9 loads this file as real ESM, where `__dirname` does not exist —
// the build fails at the first alias below without this.
const dirname = path.dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  // Storybook 9 folded addon-essentials and addon-interactions into core, and
  // both packages stopped publishing. Controls, backgrounds and the toolbar —
  // the only parts preview.ts configures — now ship with `storybook` itself.
  addons: [],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  // julIDE itself collects nothing; its build tooling shouldn't either.
  core: {
    disableTelemetry: true,
  },
  viteFinal: async (config) => {
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...config.resolve.alias,
      "@tauri-apps/api/core": path.resolve(dirname, "mocks/tauri-core.ts"),
      "@tauri-apps/api/event": path.resolve(dirname, "mocks/tauri-event.ts"),
      "@tauri-apps/plugin-opener": path.resolve(dirname, "mocks/tauri-core.ts"),
      "@tauri-apps/plugin-clipboard-manager": path.resolve(dirname, "mocks/tauri-core.ts"),
    };
    return config;
  },
};

export default config;
