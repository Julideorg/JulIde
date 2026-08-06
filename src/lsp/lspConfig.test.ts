import { describe, expect, test } from "bun:test";
import { fatouConfigPayload, lspStartOptions } from "./lspConfig";
import { defaultSettings } from "../stores/useSettingsStore";

describe("fatouConfigPayload", () => {
  test("uses the kebab-case keys Fatou's config schema expects", () => {
    // Fatou parses this with the same schema as fatou.toml, so camelCase keys
    // are silently ignored rather than rejected — the formatter would just keep
    // using its defaults with no sign anything was wrong.
    const payload = fatouConfigPayload({
      ...defaultSettings,
      fatouLineWidth: 100,
      fatouIndentWidth: 2,
    });

    expect(payload).toEqual({ format: { "line-width": 100, "indent-width": 2 } });
  });
});

describe("lspStartOptions", () => {
  test("sends the config payload to Fatou", () => {
    const options = lspStartOptions({ ...defaultSettings, lspBackend: "fatou" });

    expect(options.backend).toBe("fatou");
    expect(options.initializationOptions).toEqual(fatouConfigPayload(defaultSettings));
  });

  test("sends null to the Julia-hosted backends", () => {
    // They have their own initializationOptions schema; Fatou's would be
    // meaningless to them and was always null before.
    for (const backend of ["languageserver", "jetls"]) {
      const options = lspStartOptions({ ...defaultSettings, lspBackend: backend });
      expect(options.backend).toBe(backend);
      expect(options.initializationOptions).toBeNull();
    }
  });
});
