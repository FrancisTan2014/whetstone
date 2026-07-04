import { describe, expect, it } from "vitest";

import {
  defaultWebHostRuntimeConfig,
  hostRuntimeConfigGlobalKey,
  resolveApiUrl,
  resolveHostRuntimeConfig
} from "./hostRuntimeContracts.js";

describe("resolveHostRuntimeConfig", () => {
  it("defaults to browser-web same-origin /api when no host injects config", () => {
    for (const raw of [undefined, null]) {
      const resolution = resolveHostRuntimeConfig(raw);

      expect(resolution).toEqual({ config: defaultWebHostRuntimeConfig, ok: true });
    }
  });

  it("accepts a valid native host injection after validation", () => {
    const resolution = resolveHostRuntimeConfig({
      apiBaseUrl: "https://app.example/api",
      platform: "ios"
    });

    expect(resolution).toEqual({
      config: { apiBaseUrl: "https://app.example/api", platform: "ios" },
      ok: true
    });
  });

  it("trims surrounding whitespace on the injected base URL", () => {
    const resolution = resolveHostRuntimeConfig({
      apiBaseUrl: "  https://app.example/api  ",
      platform: "desktop"
    });

    expect(resolution).toEqual({
      config: { apiBaseUrl: "https://app.example/api", platform: "desktop" },
      ok: true
    });
  });

  it("fails loud with an actionable message on an unknown platform", () => {
    const resolution = resolveHostRuntimeConfig({ apiBaseUrl: "/api", platform: "watch" });

    expect(resolution.ok).toBe(false);
    if (resolution.ok) {
      throw new Error("expected an invalid resolution");
    }
    expect(resolution.message).toContain("platform");
    expect(resolution.message).toContain(hostRuntimeConfigGlobalKey);
  });

  it("fails loud when the injected base URL is empty", () => {
    const resolution = resolveHostRuntimeConfig({ apiBaseUrl: "   ", platform: "web" });

    expect(resolution.ok).toBe(false);
    if (resolution.ok) {
      throw new Error("expected an invalid resolution");
    }
    expect(resolution.message).toContain("apiBaseUrl");
  });

  it("rejects a native platform with a relative base URL, naming the field", () => {
    const resolution = resolveHostRuntimeConfig({ apiBaseUrl: "/api", platform: "desktop" });

    expect(resolution.ok).toBe(false);
    if (resolution.ok) {
      throw new Error("expected an invalid resolution");
    }
    expect(resolution.message).toContain("apiBaseUrl");
    expect(resolution.message).toContain("absolute");
  });

  it("rejects unknown extra keys instead of trusting a drifted shape", () => {
    const resolution = resolveHostRuntimeConfig({
      apiBaseUrl: "/api",
      extra: true,
      platform: "web"
    });

    expect(resolution.ok).toBe(false);
  });
});

describe("resolveApiUrl", () => {
  it("joins the same-origin default base with a leading-slash path", () => {
    expect(resolveApiUrl("/api", "/works")).toBe("/api/works");
  });

  it("adds the leading slash when the path omits it", () => {
    expect(resolveApiUrl("/api", "works")).toBe("/api/works");
  });

  it("collapses a trailing slash on the base to a single separator", () => {
    expect(resolveApiUrl("https://app.example/api/", "/works")).toBe(
      "https://app.example/api/works"
    );
  });

  it("preserves a query string on the path", () => {
    expect(resolveApiUrl("/api", "/search?q=dog")).toBe("/api/search?q=dog");
  });
});
