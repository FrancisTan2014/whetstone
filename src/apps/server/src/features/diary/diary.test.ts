import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DiaryEntryDto, TimelineDto } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { diaryEntries } from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import type { DiaryDependencies } from "./diaryCommands.js";
import { listDiaryEntriesForUser } from "./diaryQueries.js";

// A deterministic stand-in for the LLM tidy pass: drop standalone fillers (um/uh/er) and collapse
// immediately repeated words, while preserving every other word in order. It NEVER upgrades vocabulary,
// rephrases, or translates — so non-English text passes through untouched — which is exactly the
// tidy-not-polish invariant the real prompt instructs.
function fakeTidy(transcript: string): string {
  const fillers = new Set(["um", "uh", "er"]);
  const tokens = transcript.split(/\s+/).filter((token) => token.length > 0);
  const kept: string[] = [];
  for (const token of tokens) {
    if (fillers.has(token.toLowerCase())) {
      continue;
    }
    if (kept.at(-1) === token) {
      continue;
    }
    kept.push(token);
  }
  return kept.join(" ");
}

type TestContext = Readonly<{
  db: DbClient;
  server: ReturnType<typeof createServer>;
  setNow: (iso: string) => void;
}>;

let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);

  let now = new Date("2026-06-30T20:38:00.000Z");
  let sequence = 0;
  const diary: DiaryDependencies = {
    createId: () => `diary-${(sequence += 1)}`,
    db,
    now: () => now,
    tidy: (transcript) => Promise.resolve(fakeTidy(transcript))
  };

  return {
    db,
    server: createServer({ diary, logger: false }),
    setNow: (iso) => {
      now = new Date(iso);
    }
  };
}

async function createEntry(transcript: string): Promise<DiaryEntryDto> {
  const response = await context.server.inject({
    method: "POST",
    payload: { transcript },
    url: "/api/diary/entries"
  });
  expect(response.statusCode).toBe(201);
  return response.json() as DiaryEntryDto;
}

async function timeline(query = ""): Promise<TimelineDto> {
  const response = await context.server.inject({
    method: "GET",
    url: `/api/diary/timeline${query}`
  });
  expect(response.statusCode).toBe(200);
  return response.json() as TimelineDto;
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.server.close();
});

describe("POST /api/diary/entries", () => {
  it("tidies the transcript, filing it as a dated block under today with a timestamp", async () => {
    context.setNow("2026-06-30T20:38:00.000Z");

    const entry = await createEntry("um so today I, I went to to the park");

    expect(entry).toEqual({
      createdAt: "2026-06-30T20:38:00.000Z",
      entryDate: "2026-06-30",
      id: "diary-1",
      language: null,
      text: "so today I, I went to the park"
    });
  });

  it("drops fillers and repeats without changing the speaker's wording or meaning", async () => {
    const entry = await createEntry("um um I really really enjoyed it uh today");

    // Fillers gone, the doubled words collapsed once — but every meaningful word is preserved in order
    // and none is upgraded or rephrased.
    expect(entry.text).toBe("I really enjoyed it today");
  });

  it("rejects a blank transcript", async () => {
    const response = await context.server.inject({
      method: "POST",
      payload: { transcript: "   " },
      url: "/api/diary/entries"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("round-trips a non-English entry with its text and language unchanged (no translation)", async () => {
    const entry = await createEntry("今天 我 去 了 公园");

    expect(entry.text).toBe("今天 我 去 了 公园");
    expect(entry.language).toBeNull();
  });

  it("writes the entry to the coach-readable learner-history store for the user", async () => {
    const created = await createEntry("today I practised speaking");

    const stored = await listDiaryEntriesForUser(context.db, DEFAULT_USER_ID);

    expect(stored).toContainEqual(created);
  });
});

describe("GET /api/diary/timeline", () => {
  it("stacks same-day entries under one day and groups other days separately, newest-first", async () => {
    context.setNow("2026-06-29T09:00:00.000Z");
    await createEntry("first on the 29th");
    context.setNow("2026-06-30T08:00:00.000Z");
    await createEntry("first on the 30th");
    context.setNow("2026-06-30T10:00:00.000Z");
    await createEntry("second on the 30th");

    const page = await timeline();

    expect(page.days.map((day) => day.date)).toEqual(["2026-06-30", "2026-06-29"]);
    // Same-day entries stack under their day, oldest-first.
    expect(page.days[0]?.entries.map((entry) => entry.text)).toEqual([
      "first on the 30th",
      "second on the 30th"
    ]);
    expect(page.days[0]?.entries.every((entry) => entry.kind === "diary")).toBe(true);
    expect(page.days[1]?.entries.map((entry) => entry.text)).toEqual(["first on the 29th"]);
  });

  it("lazy-loads older days via the bounded `before` cursor, ending in an empty page", async () => {
    for (const day of ["2026-06-27", "2026-06-28", "2026-06-29", "2026-06-30"]) {
      context.setNow(`${day}T12:00:00.000Z`);
      await createEntry(`entry for ${day}`);
    }

    const firstPage = await timeline("?limit=2");
    expect(firstPage.days.map((day) => day.date)).toEqual(["2026-06-30", "2026-06-29"]);

    const secondPage = await timeline("?limit=2&before=2026-06-29");
    expect(secondPage.days.map((day) => day.date)).toEqual(["2026-06-28", "2026-06-27"]);

    const thirdPage = await timeline("?limit=2&before=2026-06-27");
    expect(thirdPage.days).toEqual([]);
  });

  it("returns an empty timeline when there are no entries", async () => {
    expect((await timeline()).days).toEqual([]);
  });

  it("rejects a malformed cursor", async () => {
    const response = await context.server.inject({
      method: "GET",
      url: "/api/diary/timeline?before=yesterday"
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/diary/calendar", () => {
  it("returns the days in range that have at least one entry", async () => {
    context.setNow("2026-06-10T12:00:00.000Z");
    await createEntry("the 10th");
    context.setNow("2026-06-20T12:00:00.000Z");
    await createEntry("the 20th");
    context.setNow("2026-07-01T12:00:00.000Z");
    await createEntry("out of range");

    const response = await context.server.inject({
      method: "GET",
      url: "/api/diary/calendar?from=2026-06-01&to=2026-06-30"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ dates: ["2026-06-10", "2026-06-20"] });
  });

  it("rejects a missing range bound", async () => {
    const response = await context.server.inject({
      method: "GET",
      url: "/api/diary/calendar?from=2026-06-01"
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("PATCH /api/diary/entries/:id", () => {
  it("edits the current user's entry text", async () => {
    const created = await createEntry("original text");

    const response = await context.server.inject({
      method: "PATCH",
      payload: { text: "edited text" },
      url: `/api/diary/entries/${created.id}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...created, text: "edited text" });
  });

  it("returns 404 for a missing entry", async () => {
    const response = await context.server.inject({
      method: "PATCH",
      payload: { text: "edited" },
      url: "/api/diary/entries/does-not-exist"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });

  it("returns 404 when editing another user's entry", async () => {
    await context.db.insert(diaryEntries).values({
      createdAt: new Date("2026-06-30T00:00:00.000Z"),
      entryDate: "2026-06-30",
      id: "other-user-entry",
      language: null,
      text: "not yours",
      userId: "someone-else"
    });

    const response = await context.server.inject({
      method: "PATCH",
      payload: { text: "hijack" },
      url: "/api/diary/entries/other-user-entry"
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects a blank edit", async () => {
    const created = await createEntry("original text");

    const response = await context.server.inject({
      method: "PATCH",
      payload: { text: "  " },
      url: `/api/diary/entries/${created.id}`
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("DELETE /api/diary/entries/:id", () => {
  it("deletes the current user's entry", async () => {
    const created = await createEntry("to be deleted");

    const response = await context.server.inject({
      method: "DELETE",
      url: `/api/diary/entries/${created.id}`
    });

    expect(response.statusCode).toBe(204);
    expect((await timeline()).days).toEqual([]);
  });

  it("returns 404 for a missing entry", async () => {
    const response = await context.server.inject({
      method: "DELETE",
      url: "/api/diary/entries/missing"
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 when deleting another user's entry", async () => {
    await context.db.insert(diaryEntries).values({
      createdAt: new Date("2026-06-30T00:00:00.000Z"),
      entryDate: "2026-06-30",
      id: "other-user-delete",
      language: null,
      text: "not yours",
      userId: "someone-else"
    });

    const response = await context.server.inject({
      method: "DELETE",
      url: "/api/diary/entries/other-user-delete"
    });

    expect(response.statusCode).toBe(404);

    // The other user's entry survives the rejected delete.
    const survivors = await listDiaryEntriesForUser(context.db, "someone-else");
    expect(survivors.map((entry) => entry.id)).toEqual(["other-user-delete"]);
  });
});
