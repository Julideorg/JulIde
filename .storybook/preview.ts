import type { Preview } from "@storybook/react";
import "../src/styles/index.css";
import { palettes } from "../src/themes/tokens";

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    // Taken from the design tokens rather than typed in — the previous
    // hardcoded "dark" backdrop was #1e1e2e, which never matched the app.
    backgrounds: {
      options: {
        dark: { name: "dark", value: palettes.dark.surface.canvas },
        light: { name: "light", value: palettes.light.surface.canvas },
      },
    },
  },
  // Storybook 9 replaced `backgrounds.default` and `globalTypes[].defaultValue`
  // with a single initial-globals block. `defaultValue` still type-checks but is
  // ignored at runtime, which would silently start every story on the wrong theme.
  initialGlobals: {
    backgrounds: { value: "dark" },
    theme: "theme-dark",
  },
  // Stories render inside the theme class so tokens resolve the same way they
  // do in the app, where App.tsx puts this class on the document element.
  globalTypes: {
    theme: {
      description: "julIDE theme",
      toolbar: {
        title: "Theme",
        icon: "paintbrush",
        items: [
          { value: "theme-dark", title: "Ink (dark)" },
          { value: "theme-light", title: "Paper (light)" },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, context) => {
      document.documentElement.className = context.globals.theme;
      return Story();
    },
  ],
};

export default preview;
