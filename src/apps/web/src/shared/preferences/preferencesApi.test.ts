// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchPreferences,
  loadPersistedTimeZone,
  resolveBrowserTimeZone,
  savePreferences
} from "./preferencesApi";

const browserZone = resolveBrowserTimeZone();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveBrowserTimeZone", () => {
  it("reports a non-empty IANA zone id", () => {
    expect(typeof browserZone).toBe("string");
    expect(browserZone.length).toBeGreaterThan(0);
  });

  it("falls back to UTC when the runtime cannot resolve a zone", () => {
    vi.stubGlobal("Intl", {
      DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: "" }) })
    } as never);
    expect(resolveBrowserTimeZone()).toBe("UTC");
  });

  it("falls back to UTC when resolving throws", () => {
    vi.stubGlobal("Intl", {
      DateTimeFormat: () => {
        throw new Error("no Intl");
      }
    } as never);
    expect(resolveBrowserTimeZone()).toBe("UTC");
  });
});

describe("fetchPreferences", () => {
  it("saves with no in-flight fetch, using the seeded defaults", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await savePreferences({ readingSize: "lg" });
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("PUT");
  });

  it("returns the validated record from the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            preferences: { readingSize: "lg", theme: "night", timeZone: "America/New_York" }
          }),
        ok: true
      })
    );

    expect(await fetchPreferences()).toEqual({
      readingSize: "lg",
      theme: "night",
      timeZone: "America/New_York"
    });
  });

  it("adopts the browser zone and persists it once when the stored zone is null (first use)", async () => {
    const fetchMock = vi
      .fn()
      // GET returns a stored record with no zone yet.
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve({ preferences: { readingSize: "md", theme: "day", timeZone: null } }),
        ok: true
      })
      // The follow-up first-use PUT.
      .mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchPreferences()).toEqual({
      readingSize: "md",
      theme: "day",
      timeZone: browserZone
    });

    // Exactly one PUT persists the browser zone back to the server.
    const puts = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(JSON.parse((puts[0]?.[1] as RequestInit).body as string).timeZone).toBe(browserZone);
  });

  it("falls back to the last-known record when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            preferences: { readingSize: "lg", theme: "night", timeZone: "America/New_York" }
          }),
        ok: true
      })
    );
    await fetchPreferences();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await fetchPreferences()).toEqual({
      readingSize: "lg",
      theme: "night",
      timeZone: "America/New_York"
    });
  });

  it("returns defaults for an invalid server body, and keeps last-known on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ json: () => Promise.resolve({ preferences: { bad: 1 } }), ok: true })
    );
    expect(await fetchPreferences()).toEqual({
      readingSize: "md",
      theme: "day",
      timeZone: browserZone
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await fetchPreferences()).toEqual({
      readingSize: "md",
      theme: "day",
      timeZone: browserZone
    });
  });
});

describe("loadPersistedTimeZone", () => {
  it("resolves the browser zone only after the first-use persistence PUT settles", async () => {
    let resolvePut: ((value: unknown) => void) | undefined;
    let markPutIssued: (() => void) | undefined;
    const putIssued = new Promise<void>((resolve) => {
      markPutIssued = resolve;
    });
    const fetchMock = vi
      .fn()
      // GET: no stored zone yet (first use).
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve({ preferences: { readingSize: "md", theme: "day", timeZone: null } }),
        ok: true
      })
      // The first-use PUT, held open so we can prove the resolve waits for persistence.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePut = resolve as never;
            markPutIssued?.();
          })
      );
    vi.stubGlobal("fetch", fetchMock);

    let settled = false;
    const pending = loadPersistedTimeZone().then((zone) => {
      settled = true;
      return zone;
    });

    // Wait deterministically until the PUT is actually in flight; the resolve must still be pending.
    await putIssued;
    expect(settled).toBe(false);

    resolvePut?.({ ok: true });
    expect(await pending).toBe(browserZone);
    const puts = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(JSON.parse((puts[0]?.[1] as RequestInit).body as string).timeZone).toBe(browserZone);
  });

  it("returns the stored zone without persisting when one is already set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          preferences: { readingSize: "lg", theme: "night", timeZone: "America/New_York" }
        }),
      ok: true
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await loadPersistedTimeZone()).toBe("America/New_York");
    const puts = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === "PUT");
    expect(puts).toHaveLength(0);
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

  it("serializes concurrent size+theme saves so the last PUT carries both fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      savePreferences({ readingSize: "xl" }),
      savePreferences({ theme: "night" })
    ]);

    const puts = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === "PUT");
    const lastBody = JSON.parse((puts[puts.length - 1]?.[1] as RequestInit).body as string);
    expect(lastBody.readingSize).toBe("xl");
    expect(lastBody.theme).toBe("night");
  });

  it("waits for an in-flight fetch so a single-field save keeps the server's other field", async () => {
    let resolveFetch: ((value: unknown) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve as never;
          })
      )
      .mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const load = fetchPreferences();
    // Save reading size before the load resolves; the server has theme night, size md.
    const save = savePreferences({ readingSize: "xl" });
    resolveFetch?.({
      json: () =>
        Promise.resolve({
          preferences: { readingSize: "md", theme: "night", timeZone: "America/New_York" }
        }),
      ok: true
    });
    await load;
    await save;

    const put = fetchMock.mock.calls.find((call) => (call[1] as RequestInit)?.method === "PUT");
    const body = JSON.parse((put?.[1] as RequestInit).body as string);
    expect(body.readingSize).toBe("xl");
    expect(body.theme).toBe("night");
  });
});
