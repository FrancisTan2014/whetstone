import { createTextDocument } from "@whetstone/document";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addImportedWorkSection,
  fetchImportedWork,
  fetchImportedWorkUnit,
  saveImportedWorkContent
} from "./importedWorkApi";

const document = createTextDocument("An imported passage.");

const sections = [
  { orderIndex: 0, unitEntryId: "unit-1" },
  { headingLevel: 1, orderIndex: 1, title: "Chapter", unitEntryId: "unit-2" }
];

// The imported DTO omits owner chronology (`createdAt`/`updatedAt`) and adds `correctedAt`; the client
// parses through the shared contract at the boundary, so a body carrying manual-only fields would be
// rejected. `correctedAt` is null while the Work is still exactly as ingested.
const dto = {
  correctedAt: null,
  document,
  entryId: "work-1",
  language: "en" as const,
  revision: 3,
  sections,
  title: "Politics and the English Language",
  unitEntryId: "unit-1",
  workType: "essay" as const
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

describe("fetchImportedWork", () => {
  it("parses the loaded imported work at the boundary", async () => {
    const fetchMock = stubFetch({ ok: true, body: dto });

    await expect(fetchImportedWork("work-1")).resolves.toEqual(dto);
    expect(fetchMock).toHaveBeenCalledWith("/api/imported-works/work-1");
  });

  it("throws when the load fails", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(fetchImportedWork("work-1")).rejects.toThrow(/status 404/);
  });
});

describe("fetchImportedWorkUnit", () => {
  it("parses one section's document at the boundary", async () => {
    const fetchMock = stubFetch({ ok: true, body: unitDto });

    await expect(fetchImportedWorkUnit("work-1", "unit-2")).resolves.toEqual(unitDto);
    expect(fetchMock).toHaveBeenCalledWith("/api/imported-works/work-1/units/unit-2");
  });

  it("throws when the section load fails", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(fetchImportedWorkUnit("work-1", "unit-2")).rejects.toThrow(/status 404/);
  });
});

describe("saveImportedWorkContent", () => {
  it("returns the reopened work on success and targets the section path", async () => {
    const fetchMock = stubFetch({ ok: true, body: dto });

    await expect(
      saveImportedWorkContent("work-1", "unit-2", document, dto.revision)
    ).resolves.toEqual({
      status: "saved",
      work: dto
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/imported-works/work-1/units/unit-2/content",
      expect.objectContaining({ method: "PUT" })
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ document, revision: dto.revision });
  });

  it("reports a stale revision as a conflict", async () => {
    stubFetch({ ok: false, status: 409 });

    await expect(saveImportedWorkContent("work-1", "unit-1", document, 1)).resolves.toEqual({
      status: "conflict"
    });
  });

  it("reports a rejected document as invalid", async () => {
    stubFetch({ ok: false, status: 400 });

    await expect(saveImportedWorkContent("work-1", "unit-1", document, 2)).resolves.toEqual({
      status: "invalid"
    });
  });

  it("throws on an unexpected non-2xx response", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(saveImportedWorkContent("work-1", "unit-1", document, 2)).rejects.toThrow(
      /status 500/
    );
  });
});

describe("addImportedWorkSection", () => {
  it("returns the work opened at the new section on success", async () => {
    const fetchMock = stubFetch({ ok: true, body: dto });

    await expect(addImportedWorkSection("work-1", "unit-1", "next", dto.revision)).resolves.toEqual(
      {
        status: "added",
        work: dto
      }
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/imported-works/work-1/units",
      expect.objectContaining({ method: "POST" })
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      placement: "next",
      revision: dto.revision,
      targetUnitEntryId: "unit-1"
    });
  });

  it("reports a stale revision as a conflict", async () => {
    stubFetch({ ok: false, status: 409 });

    await expect(addImportedWorkSection("work-1", "unit-1", "next", 1)).resolves.toEqual({
      status: "conflict"
    });
  });

  it("throws on an unexpected non-2xx response", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(addImportedWorkSection("work-1", "unit-1", "next", 2)).rejects.toThrow(
      /status 500/
    );
  });
});
