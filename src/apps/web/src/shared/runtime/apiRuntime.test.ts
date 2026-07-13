import { defaultWebHostRuntimeConfig } from "@whetstone/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { apiUrl, bootstrapApiRuntime, hostPlatform, initializeApiRuntime } from "./apiRuntime";

// The runtime is module-level state; reset it to the browser-web default after each case so cases stay
// independent (mirrors the boundary's default when no host injects config).
afterEach(() => {
  initializeApiRuntime(defaultWebHostRuntimeConfig);
});

describe("apiUrl", () => {
  it("resolves to same-origin /api by default", () => {
    expect(apiUrl("/works")).toBe("/api/works");
    expect(hostPlatform()).toBe("web");
  });

  it("resolves against an installed native host base", () => {
    initializeApiRuntime({ apiBaseUrl: "https://app.example/api", platform: "ios" });

    expect(apiUrl("/works/42/structure")).toBe("https://app.example/api/works/42/structure");
    expect(hostPlatform()).toBe("ios");
  });
});

describe("bootstrapApiRuntime", () => {
  it("keeps the browser-web default when the scope injects nothing", () => {
    const resolution = bootstrapApiRuntime({});

    expect(resolution).toEqual({ config: defaultWebHostRuntimeConfig, ok: true });
    expect(apiUrl("/works")).toBe("/api/works");
    expect(hostPlatform()).toBe("web");
  });

  it("installs a valid injected native host config", () => {
    const resolution = bootstrapApiRuntime({
      __WHETSTONE_HOST_CONFIG__: { apiBaseUrl: "https://desktop.local/api", platform: "desktop" }
    });

    expect(resolution.ok).toBe(true);
    expect(apiUrl("/search?q=dog")).toBe("https://desktop.local/api/search?q=dog");
    expect(hostPlatform()).toBe("desktop");
  });

  it("fails loud without installing anything on invalid injected config", () => {
    const resolution = bootstrapApiRuntime({
      __WHETSTONE_HOST_CONFIG__: { apiBaseUrl: "/api", platform: "ios" }
    });

    expect(resolution.ok).toBe(false);
    if (resolution.ok) {
      throw new Error("expected an invalid resolution");
    }
    expect(resolution.message).toContain("apiBaseUrl");
    // The invalid host config is never installed: the runtime stays on the safe default.
    expect(apiUrl("/works")).toBe("/api/works");
    expect(hostPlatform()).toBe("web");
  });
});
