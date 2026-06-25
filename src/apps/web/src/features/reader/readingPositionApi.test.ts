import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchReadingPosition, saveReadingPosition } from "./readingPositionApi";

function stubFetch(response: {
  ok: boolean;
  status?: number;
  body?: unknown;
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    json: async () => response.body,
    ok: response.ok,
    status: response.status ?? 200
  }));
  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchReadingPosition", () => {
  it("returns a saved unit with its block anchor", async () => {
    stubFetch({ body: { position: { anchorBlockEntryId: "b-2", unitEntryId: "u-1" } }, ok: true });

    await expect(fetchReadingPosition("work 1")).resolves.toEqual({
      anchorBlockEntryId: "b-2",
      unitEntryId: "u-1"
    });
  });

  it("drops a null anchor to the top of the unit", async () => {
    stubFetch({ body: { position: { anchorBlockEntryId: null, unitEntryId: "u-1" } }, ok: true });

    await expect(fetchReadingPosition("work-1")).resolves.toEqual({ unitEntryId: "u-1" });
  });

  it("returns undefined when there is no saved position", async () => {
    const fetchMock = stubFetch({ body: { position: null }, ok: true });

    await expect(fetchReadingPosition("work-1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/works/work-1/reading-position");
  });

  it("throws when the server responds with a non-ok status", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(fetchReadingPosition("work-1")).rejects.toThrow("failed with status 500");
  });
});

describe("saveReadingPosition", () => {
  it("PUTs the unit and block anchor", async () => {
    const fetchMock = stubFetch({ ok: true, status: 204 });

    await saveReadingPosition("work 1", { anchorBlockEntryId: "b-2", unitEntryId: "u-1" });

    expect(fetchMock).toHaveBeenCalledWith("/api/works/work%201/reading-position", {
      body: JSON.stringify({ unitEntryId: "u-1", anchorBlockEntryId: "b-2" }),
      headers: { "content-type": "application/json" },
      method: "PUT"
    });
  });

  it("PUTs just the unit when there is no anchor", async () => {
    const fetchMock = stubFetch({ ok: true, status: 204 });

    await saveReadingPosition("work-1", { unitEntryId: "u-1" });

    expect(fetchMock).toHaveBeenCalledWith("/api/works/work-1/reading-position", {
      body: JSON.stringify({ unitEntryId: "u-1" }),
      headers: { "content-type": "application/json" },
      method: "PUT"
    });
  });

  it("throws when the server responds with a non-ok status", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(saveReadingPosition("work-1", { unitEntryId: "u-1" })).rejects.toThrow(
      "failed with status 500"
    );
  });
});
