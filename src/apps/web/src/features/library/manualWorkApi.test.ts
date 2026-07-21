import { createTextDocument } from "@whetstone/document";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addManualWorkSection,
  fetchManualWork,
  fetchManualWorkUnit,
  saveManualWorkContent
} from "./manualWorkApi";

const document = createTextDocument("A curated passage.");

const sections = [
  { orderIndex: 0, unitEntryId: "unit-1" },
  { headingLevel: 1, orderIndex: 1, title: "Chapter", unitEntryId: "unit-2" }
];

const dto = {
  createdAt: "2026-07-01T10:00:00.000Z",
  document,
  entryId: "work-1",
  language: "en" as const,
  revision: "2026-07-01T11:00:00.000Z",
  sections,
  title: "Reading notes",
  unitEntryId: "unit-1",
  updatedAt: "2026-07-01T11:00:00.000Z",
  workType: "book" as const
};

const unitDto = {
  document,
  unitEntryId: "unit-2"
};

function stubFetch(response: {
  ok: boolean;
  status?: number;
  body?: unknown;
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: response.ok,
    status: response.status ?? 200,
    json: async () => response.body
  }));
  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchManualWork", () => {
  it("parses the loaded manual work at the boundary", async () => {
    const fetchMock = stubFetch({ ok: true, body: dto });

    await expect(fetchManualWork("work-1")).resolves.toEqual(dto);
    expect(fetchMock).toHaveBeenCalledWith("/api/manual-works/work-1");
  });

  it("throws when the load fails", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(fetchManualWork("work-1")).rejects.toThrow(/status 404/);
  });
});

describe("fetchManualWorkUnit", () => {
  it("parses one section's document at the boundary", async () => {
    const fetchMock = stubFetch({ ok: true, body: unitDto });

    await expect(fetchManualWorkUnit("work-1", "unit-2")).resolves.toEqual(unitDto);
    expect(fetchMock).toHaveBeenCalledWith("/api/manual-works/work-1/units/unit-2");
  });

  it("throws when the section load fails", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(fetchManualWorkUnit("work-1", "unit-2")).rejects.toThrow(/status 404/);
  });
});

describe("saveManualWorkContent", () => {
  it("returns the reopened work on success and targets the section path", async () => {
    const fetchMock = stubFetch({ ok: true, body: dto });

    await expect(
      saveManualWorkContent("work-1", "unit-2", document, dto.revision)
    ).resolves.toEqual({
      status: "saved",
      work: dto
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/manual-works/work-1/units/unit-2/content",
      expect.objectContaining({ method: "PUT" })
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ document, revision: dto.revision });
  });

  it("reports a stale revision as a conflict", async () => {
    stubFetch({ ok: false, status: 409 });

    await expect(saveManualWorkContent("work-1", "unit-1", document, "old")).resolves.toEqual({
      status: "conflict"
    });
  });

  it("reports a rejected document as invalid", async () => {
    stubFetch({ ok: false, status: 400 });

    await expect(saveManualWorkContent("work-1", "unit-1", document, "r")).resolves.toEqual({
      status: "invalid"
    });
  });

  it("throws on an unexpected non-2xx response", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(saveManualWorkContent("work-1", "unit-1", document, "r")).rejects.toThrow(
      /status 500/
    );
  });
});

describe("addManualWorkSection", () => {
  it("returns the work opened at the new section on success", async () => {
    const fetchMock = stubFetch({ ok: true, body: dto });

    await expect(addManualWorkSection("work-1", dto.revision)).resolves.toEqual({
      status: "added",
      work: dto
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/manual-works/work-1/units",
      expect.objectContaining({ method: "POST" })
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ revision: dto.revision });
  });

  it("reports a stale revision as a conflict", async () => {
    stubFetch({ ok: false, status: 409 });

    await expect(addManualWorkSection("work-1", "old")).resolves.toEqual({ status: "conflict" });
  });

  it("throws on an unexpected non-2xx response", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(addManualWorkSection("work-1", "r")).rejects.toThrow(/status 500/);
  });
});
