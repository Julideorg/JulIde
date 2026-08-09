import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      "src-tauri/target",
      "src-tauri/gen",
      // Generated from JuliaLang's symbol tables by scripts/generate-latex-unicode.ts.
      "src/components/Editor/latexUnicode.ts",
      // Bundled from src/plugin-sdk/bootstrap.ts by scripts/build-plugin-bootstrap.ts.
      // The source is linted; the bundle is a build artifact.
      "src-tauri/assets/plugin-bootstrap.js",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.es2022 },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // Fast Refresh works best when a module exports only components. This is a
      // warning rather than an error: several files here deliberately co-locate a
      // component with a helper, and forcing a split would be churn for no gain.
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],

      // Unused args are often there for signature clarity; allow the _ convention.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],

      // `any` is already rare here (about 20 occurrences, mostly in mocks and the
      // LSP payload boundary). Flag new ones without failing the build on the
      // existing set.
      "@typescript-eslint/no-explicit-any": "warn",

      // ── React Compiler-era rules: warn, do not error ──────────────────
      //
      // These three flag patterns that are idiomatic React but suboptimal under
      // the compiler. They fire ~16 times across existing components, and each
      // fix is a behavioural change rather than a mechanical one:
      //
      //  - set-state-in-effect: the fetch-then-setState pattern in StatusBar,
      //    OutlinePanel, DataFrameViewer and friends.
      //  - refs: App.tsx reads `mountedBottomPanelsRef` during render, which is
      //    what keeps terminal panels mounted-but-hidden so REPL buffers and
      //    scroll position survive tab switches. Converting it to state risks
      //    remounting terminals and losing session output.
      //  - preserve-manual-memoization: existing useCallback deps in OutlinePanel.
      //
      // Left visible as warnings so they stay on the backlog, rather than
      // silenced or rushed into a blind refactor.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },

  // Test files and Storybook stories: relax the rules that only make sense for
  // application code.
  {
    files: ["**/*.test.{ts,tsx}", "src/__test__/**", "**/*.stories.tsx", ".storybook/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "react-refresh/only-export-components": "off",
    },
  },

  // Node-context files.
  {
    files: ["scripts/**", "*.config.{ts,js}", ".storybook/**"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // Must come last: turns off everything that would fight Prettier.
  prettier,
);
