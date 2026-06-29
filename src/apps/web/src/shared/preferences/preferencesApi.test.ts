// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchPreferences, savePreferences } from "./preferencesApi";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchPreferences", () => {
  it("returns the validated record from the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ preferences: { readingSize: "lg", theme: "night" } }),
        ok: true
      })
    );

    expect(await fetchPreferences()).toEqual({ readingSize: "lg", theme: "night" });
  });

  it("falls back to the last-known record when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ preferences: { readingSize: "lg", theme: "night" } }),
        ok: true
      })
    );
    await fetchPreferences();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await fetchPreferences()).toEqual({ readingSize: "lg", theme: "night" });
  });

  it("returns defaults for an invalid server body, and keeps last-known on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ json: () => Promise.resolve({ preferences: { bad: 1 } }), ok: true })
    );
    expect(await fetchPreferences()).toEqual({ readingSize: "md", theme: "day" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await fetchPreferences()).toEqual({ readingSize: "md", theme: "day" });
  });
});

describe("savePreferences", () => {
  it("PUTs the merged record so a single-field change keeps the other", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await savePreferences({ readingSize: "xl" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/preferences");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string).readingSize).toBe("xl");
  });

  it("swallows a failed save so reading is never blocked", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(savePreferences({ theme: "night" })).resolves.toBeUndefined();
  });
});
