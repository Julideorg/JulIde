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
      default: "dark",
      values: [
        { name: "dark", value: palettes.dark.surface.canvas },
        { name: "light", value: palettes.light.surface.canvas },
      ],
    },
  },
  // Stories render inside the theme class so tokens resolve the same way they
  // do in the app, where App.tsx puts this class on the document element.
  globalTypes: {
    theme: {
      description: "julIDE theme",
      defaultValue: "theme-dark",
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
