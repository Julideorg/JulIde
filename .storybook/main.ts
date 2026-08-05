import type { StorybookConfig } from "@storybook/react-vite";
import path from "path";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-essentials", "@storybook/addon-interactions"],
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
      "@tauri-apps/api/core": path.resolve(__dirname, "mocks/tauri-core.ts"),
      "@tauri-apps/api/event": path.resolve(__dirname, "mocks/tauri-event.ts"),
      "@tauri-apps/plugin-opener": path.resolve(__dirname, "mocks/tauri-core.ts"),
      "@tauri-apps/plugin-clipboard-manager": path.resolve(__dirname, "mocks/tauri-core.ts"),
    };
    return config;
  },
};

export default config;
