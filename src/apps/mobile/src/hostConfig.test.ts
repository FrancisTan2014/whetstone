import {
  hostRuntimeConfigGlobalKey,
  hostRuntimeConfigSchema,
  resolveHostRuntimeConfig
} from "@whetstone/contracts";
import { describe, expect, it } from "vitest";

import { hostConfigInjectionScript, injectHostConfigScript, iosHostConfig } from "./hostConfig";

describe("iosHostConfig", () => {
  it("builds an ios platform config with the given absolute base", () => {
    expect(iosHostConfig("https://app.example/api")).toEqual({
      apiBaseUrl: "https://app.example/api",
      platform: "ios"
    });
  });

  it("trims surrounding whitespace from the base", () => {
    expect(iosHostConfig("  https://app.example/api  ")).toEqual({
      apiBaseUrl: "https://app.example/api",
      platform: "ios"
    });
  });

  it("produces a config the shared web contract accepts as a valid native host", () => {
    const parsed = hostRuntimeConfigSchema.safeParse(iosHostConfig("https://app.example/api"));

    expect(parsed.success).toBe(true);
  });
});

describe("hostConfigInjectionScript", () => {
  it("assigns the JSON-encoded config to the shared global key", () => {
    const script = hostConfigInjectionScript(iosHostConfig("https://app.example/api"));

    expect(script).toBe(
      `window.${hostRuntimeConfigGlobalKey} = {"apiBaseUrl":"https://app.example/api","platform":"ios"};`
    );
  });

  it("emits JS that the web boundary resolves back into the same installed config", () => {
    const config = iosHostConfig("https://app.example/api");
    const script = hostConfigInjectionScript(config);

    // Execute the injection the way the webview would, then resolve it exactly like the web boundary.
    const scope: Record<string, unknown> = {};
    new Function("window", script)(scope);
    const resolution = resolveHostRuntimeConfig(scope[hostRuntimeConfigGlobalKey]);

    expect(resolution).toEqual({ config, ok: true });
  });
});

describe("injectHostConfigScript", () => {
  it("inserts the script just before </head>", () => {
    const html = "<!doctype html><html><head><title>whetstone</title></head><body></body></html>";
    const result = injectHostConfigScript(html, "window.X = 1;");

    expect(result).toContain("<script>window.X = 1;</script>\n  </head>");
    expect(result.indexOf("<script>window.X = 1;</script>")).toBeLessThan(
      result.indexOf("</head>")
    );
    expect(result.indexOf("</head>")).toBeLessThan(result.indexOf("<body>"));
  });

  it("fails loud when the document has no </head>", () => {
    expect(() => injectHostConfigScript("<html><body></body></html>", "window.X = 1;")).toThrow(
      /no <\/head>/
    );
  });
});
