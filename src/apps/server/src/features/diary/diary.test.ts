import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CaptureInputMode, DiaryEntryDto, TimelineDto } from "@whetstone/contracts";
import {
  createTextDocument,
  documentReadableText,
  documentText,
  parseDocument,
  serializeDocument,
  type DocumentNodeJSON
} from "@whetstone/document";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  diaryEntries,
  entries,
  memoryPrompts,
  notes,
  personalEntries,
  readerPreferences
} from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import { fingerprintNoteMaterial } from "../notes/noteMaterialFingerprint.js";
import type { DiaryRouteDependencies } from "./diaryRoutes.js";
import { listDiaryEntriesForUser } from "./diaryQueries.js";

// Seed a diary Entry (its three facets) directly, bypassing the capture command — used to plant another
// user's entry or an in-flight/failed voice capture (a `processing_status` other than null/ready).
async function seedDiaryEntry(
  db: DbClient,
  row: Readonly<{
    bodyText: string;
    id: string;
    inputMode?: CaptureInputMode;
    occurredAt: string;
    processingStatus?: "queued" | "transcribing" | "tidying" | "ready" | "failed" | null;
    userId: string;
  }>
): Promise<void> {
  const at = new Date(row.occurredAt);
  const status = row.processingStatus ?? null;
  const bodyDoc = createTextDocument(row.bodyText);
  await db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: row.id, type: "diary_entry" });
    await tx.insert(personalEntries).values({
      createdAt: at,
      entryId: row.id,
      occurredAt: at,
      updatedAt: at,
      userId: row.userId
    });
    await tx.insert(diaryEntries).values({
      bodyDoc,
      bodyText: row.bodyText,
      entryId: row.id,
      failureReason: null,
      inputMode: row.inputMode ?? "typed",
      language: null,
      processingStatus: status,
      rawAudioPath: status === null ? null : "voice-captures/seed.audio",
      rawTranscript: row.bodyText,
      tidiedText: null
    });
  });
}

// Seed a personal Note Entry (owner + chronology facet + note content), enough for the logical Timeline
// to project it as a `kind === "note"` row. No anchor is needed: the Timeline reads notes by their
// personal-entry chronology, not their block anchor.
async function seedNote(
  db: DbClient,
  row: Readonly<{ id: string; markdown: string; occurredAt: string; userId: string }>
): Promise<void> {
  const at = new Date(row.occurredAt);
  await db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: row.id, type: "note" });
    await tx.insert(personalEntries).values({
      createdAt: at,
      entryId: row.id,
      occurredAt: at,
      updatedAt: at,
      userId: row.userId
    });
    await tx.insert(notes).values({
      bodyDoc: createTextDocument(row.markdown),
      bodyText: row.markdown,
      captureSource: "reader",
      entryId: row.id,
      kind: "note",
      materialFingerprint: fingerprintNoteMaterial(createTextDocument(row.markdown))
    });
  });
}

// Seed a Memory note (its unified `notes` facets) directly, optionally with one prompt, so the Timeline
// projection of a Memory note (fragment, capture source, and prompt count) can be asserted without the
// capture command. A Memory note is an unanchored `notes` row (kind='note'), like any manual note.
async function seedMemoryNote(
  db: DbClient,
  row: Readonly<{
    id: string;
    bodyText: string;
    captureSource: "manual" | "reader" | "import" | "practice" | "tool";
    occurredAt: string;
    userId: string;
    withPrompt?: boolean;
  }>
): Promise<void> {
  const at = new Date(row.occurredAt);
  await db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: row.id, type: "note" });
    await tx.insert(personalEntries).values({
      createdAt: at,
      entryId: row.id,
      occurredAt: at,
      updatedAt: at,
      userId: row.userId
    });
    await tx.insert(notes).values({
      bodyDoc: createTextDocument(row.bodyText),
      bodyText: row.bodyText,
      captureSource: row.captureSource,
      entryId: row.id,
      kind: "note",
      materialFingerprint: fingerprintNoteMaterial(createTextDocument(row.bodyText))
    });
    if (row.withPrompt === true) {
      await tx.insert(entries).values({ id: `${row.id}-prompt`, type: "memory_prompt" });
      await tx.insert(memoryPrompts).values({
        cueDoc: createTextDocument("cue"),
        cueText: "cue",
        entryId: `${row.id}-prompt`,
        lifecycle: "draft",
        noteEntryId: row.id,
        revealKind: "legacy_custom"
      });
    }
  });
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
  const diary: DiaryRouteDependencies = {
    createId: () => `diary-${(sequence += 1)}`,
    db,
    deleteAudio: () => Promise.resolve(),
    now: () => now,
    saveAudio: () => Promise.resolve("voice-captures/test.audio")
  };

  return {
    db,
    server: createServer({ diary, logger: false }),
    setNow: (iso) => {
      now = new Date(iso);
    }
  };
}

async function createEntry(body: string | DocumentNodeJSON): Promise<DiaryEntryDto> {
  const bodyDoc = typeof body === "string" ? createTextDocument(body) : body;
  const response = await context.server.inject({
    method: "POST",
    payload: { bodyDoc },
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
  it("saves a typed capture first — ready immediately, storing the canonical document byte-for-byte (#678)", async () => {
    context.setNow("2026-06-30T20:38:00.000Z");

    // A multi-block rich document the learner authored in the shared editor.
    const bodyDoc: DocumentNodeJSON = {
      content: [
        { content: [{ text: "A good day", type: "text" }], type: "heading" },
        { content: [{ text: "I went to the park.", type: "text" }], type: "paragraph" }
      ],
      type: "doc"
    };

    const entry = await createEntry(bodyDoc);

    // Save-first: the entry is ready on write (no async status), stamped at `now`, its input mode fixed to
    // typed by the server, no language, and its plaintext projection derived via the shared readable-text
    // helper (block-boundary spaces).
    expect(entry).toMatchObject({
      bodyText: documentReadableText(bodyDoc),
      createdAt: "2026-06-30T20:38:00.000Z",
      id: "diary-1",
      inputMode: "typed",
      language: null,
      occurredAt: "2026-06-30T20:38:00.000Z",
      processingStatus: null,
      updatedAt: "2026-06-30T20:38:00.000Z"
    });
    // The durable body is the exact document the learner authored — never flattened to plaintext and
    // rebuilt (its heading/paragraph structure survives).
    expect(entry.bodyDoc).toEqual(bodyDoc);

    // Persisted: it reads back from the owner's diary store as the same DTO.
    expect(await listDiaryEntriesForUser(context.db, DEFAULT_USER_ID)).toEqual([entry]);
  });

  it("fixes inputMode to typed on the server and keeps no second transcript copy (#678)", async () => {
    // Even if a client smuggles inputMode/rawTranscript, the request schema is strict, so the only
    // accepted shape is { bodyDoc }; the server owns inputMode and stores no raw transcript.
    const entry = await createEntry("a plain thought");
    expect(entry.inputMode).toBe("typed");

    const [stored] = await context.db
      .select({ inputMode: diaryEntries.inputMode, rawTranscript: diaryEntries.rawTranscript })
      .from(diaryEntries)
      .where(eq(diaryEntries.entryId, entry.id));
    expect(stored).toEqual({ inputMode: "typed", rawTranscript: null });
  });

  it("persists a typed capture with no language and never translates the body", async () => {
    const entry = await createEntry("今天我去了公园");

    expect(entry.bodyText).toBe("今天我去了公园");
    expect(entry.language).toBeNull();
    expect(entry.inputMode).toBe("typed");
  });

  it("rejects a document with no readable text (only empty structural nodes, #678)", async () => {
    const response = await context.server.inject({
      method: "POST",
      payload: { bodyDoc: { content: [{ type: "paragraph" }], type: "doc" } },
      url: "/api/diary/entries"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("rejects a malformed or missing body document (#678)", async () => {
    const malformed = await context.server.inject({
      method: "POST",
      payload: { bodyDoc: { content: [{ type: "bogus" }], type: "doc" } },
      url: "/api/diary/entries"
    });
    expect(malformed.statusCode).toBe(400);

    const missing = await context.server.inject({
      method: "POST",
      payload: {},
      url: "/api/diary/entries"
    });
    expect(missing.statusCode).toBe(400);
  });

  it("no longer accepts the legacy transcript/inputMode shape (#678)", async () => {
    const response = await context.server.inject({
      method: "POST",
      payload: { inputMode: "typed", transcript: "a valid thought" },
      url: "/api/diary/entries"
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/diary/timeline (the logical Timeline)", () => {
  it("groups days newest-first and orders same-day entries newest-first with a stable tie-break", async () => {
    context.setNow("2026-06-29T09:00:00.000Z");
    await createEntry("first on the 29th");
    context.setNow("2026-06-30T08:00:00.000Z");
    await createEntry("earlier on the 30th");
    context.setNow("2026-06-30T10:00:00.000Z");
    await createEntry("later on the 30th");

    const page = await timeline();

    expect(page.days.map((day) => day.date)).toEqual(["2026-06-30", "2026-06-29"]);
    // Within a day: newest occurredAt first (deterministic order over personal entries).
    expect(page.days[0]?.entries.map((entry) => entry.entryId)).toEqual(["diary-3", "diary-2"]);
    expect(page.days[0]?.entries.every((entry) => entry.kind === "diary")).toBe(true);
    expect(page.days[1]?.entries.map((entry) => entry.entryId)).toEqual(["diary-1"]);
  });

  it("projects both diary and note personal Entries through the discriminated DTO, ordered by occurredAt", async () => {
    context.setNow("2026-06-30T09:00:00.000Z");
    await createEntry("a diary moment");
    await seedNote(context.db, {
      id: "note-1",
      markdown: "a reading note",
      occurredAt: "2026-06-30T11:00:00.000Z",
      userId: DEFAULT_USER_ID
    });

    const page = await timeline();
    const day = page.days[0];
    expect(day?.date).toBe("2026-06-30");
    // Note (11:00) sorts before the diary (09:00) — newest first — and each keeps its own shape.
    const [first, second] = day?.entries ?? [];
    expect(first).toMatchObject({ entryId: "note-1", kind: "note", text: "a reading note" });
    expect(second).toMatchObject({ bodyText: "a diary moment", entryId: "diary-1", kind: "diary" });
  });

  it("projects a Memory note once, carrying its fragment, capture source, and prompt count", async () => {
    await seedMemoryNote(context.db, {
      id: "mem-1",
      bodyText: "kanmusu",
      captureSource: "reader",
      occurredAt: "2026-06-30T12:00:00.000Z",
      userId: DEFAULT_USER_ID,
      withPrompt: true
    });

    const entry = (await timeline()).days[0]?.entries[0];
    expect(entry).toMatchObject({
      captureSource: "reader",
      entryId: "mem-1",
      kind: "note",
      promptCount: 1,
      text: "kanmusu"
    });
  });

  it("counts a Memory note with no prompts as zero on the Timeline", async () => {
    await seedMemoryNote(context.db, {
      id: "mem-2",
      bodyText: "bare",
      captureSource: "manual",
      occurredAt: "2026-06-30T12:00:00.000Z",
      userId: DEFAULT_USER_ID
    });

    const entry = (await timeline()).days[0]?.entries[0];
    expect(entry).toMatchObject({
      captureSource: "manual",
      entryId: "mem-2",
      kind: "note",
      promptCount: 0
    });
  });

  it("hides an in-flight or failed voice capture until it is ready", async () => {
    await seedDiaryEntry(context.db, {
      bodyText: "",
      id: "queued-1",
      inputMode: "voice",
      occurredAt: "2026-06-30T09:00:00.000Z",
      processingStatus: "queued",
      userId: DEFAULT_USER_ID
    });
    const ready = await createEntry("a ready entry");

    const ids = (await timeline()).days.flatMap((day) => day.entries.map((entry) => entry.entryId));
    expect(ids).toEqual([ready.id]);
  });

  it("scopes the Timeline to the current user", async () => {
    await seedDiaryEntry(context.db, {
      bodyText: "another user's entry",
      id: "other-1",
      occurredAt: "2026-06-30T09:00:00.000Z",
      userId: "someone-else"
    });
    const mine = await createEntry("my entry");

    const ids = (await timeline()).days.flatMap((day) => day.entries.map((entry) => entry.entryId));
    expect(ids).toEqual([mine.id]);
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

describe("day grouping honors the learner's stored timezone (#606)", () => {
  // Two instants on the same UTC calendar day (2026-06-10) that fall on DIFFERENT days in a zone behind
  // UTC: 02:00Z is still 2026-06-09 in New York (UTC−4 in June), while 12:00Z is 2026-06-10 there.
  async function seedStraddlingEntries(): Promise<void> {
    context.setNow("2026-06-10T02:00:00.000Z");
    await createEntry("late on the 9th in New York");
    context.setNow("2026-06-10T12:00:00.000Z");
    await createEntry("midday on the 10th in New York");
  }

  it("groups the timeline by the learner's local day", async () => {
    await seedStraddlingEntries();
    await context.db.insert(readerPreferences).values({
      readingSize: "md",
      theme: "day",
      timezone: "America/New_York",
      userId: DEFAULT_USER_ID
    });

    const page = await timeline();
    expect(page.days.map((day) => day.date)).toEqual(["2026-06-10", "2026-06-09"]);
  });
});

describe("PATCH /api/diary/entries/:id (rich editing)", () => {
  it("replaces the body through the shared editor and bumps updatedAt, keeping occurredAt/createdAt", async () => {
    context.setNow("2026-06-30T20:38:00.000Z");
    const created = await createEntry("original text");

    context.setNow("2026-07-01T08:00:00.000Z");
    const nextDoc: DocumentNodeJSON = createTextDocument("edited body");
    const response = await context.server.inject({
      method: "PATCH",
      payload: { bodyDoc: nextDoc },
      url: `/api/diary/entries/${created.id}`
    });

    expect(response.statusCode).toBe(200);
    const updated = response.json() as DiaryEntryDto;
    expect(updated.bodyText).toBe("edited body");
    expect(documentText(updated.bodyDoc)).toBe("edited body");
    expect(updated.occurredAt).toBe(created.occurredAt);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBe("2026-07-01T08:00:00.000Z");
    expect(updated.language).toBeNull();
  });

  it("stores a readable body_text projection for a multi-block body (#571)", async () => {
    const created = await createEntry("original text");

    // A two-paragraph body: the durable doc holds two blocks, so the display projection must read them
    // with a boundary rather than concatenating them into one run.
    const twoBlockDoc = serializeDocument(
      parseDocument({
        content: [
          ...(createTextDocument("First paragraph.").content ?? []),
          ...(createTextDocument("Second paragraph.").content ?? [])
        ],
        type: "doc"
      })
    );

    const response = await context.server.inject({
      method: "PATCH",
      payload: { bodyDoc: twoBlockDoc },
      url: `/api/diary/entries/${created.id}`
    });

    expect(response.statusCode).toBe(200);
    const updated = response.json() as DiaryEntryDto;
    // body_text is the readable projection (a space between blocks), NOT the separator-free stream.
    expect(updated.bodyText).toBe(documentReadableText(twoBlockDoc));
    expect(updated.bodyText).toBe("First paragraph. Second paragraph.");
    expect(documentText(twoBlockDoc)).toBe("First paragraph.Second paragraph.");
  });

  it("optionally updates the language alongside the body", async () => {
    const created = await createEntry("original");

    const response = await context.server.inject({
      method: "PATCH",
      payload: { bodyDoc: createTextDocument("改过的正文"), language: "zh" },
      url: `/api/diary/entries/${created.id}`
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as DiaryEntryDto).language).toBe("zh");
  });

  it("rejects a body that is not a valid document", async () => {
    const created = await createEntry("original text");

    const response = await context.server.inject({
      method: "PATCH",
      payload: { bodyDoc: { type: "paragraph" } },
      url: `/api/diary/entries/${created.id}`
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 404 for a missing entry", async () => {
    const response = await context.server.inject({
      method: "PATCH",
      payload: { bodyDoc: createTextDocument("edited") },
      url: "/api/diary/entries/does-not-exist"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });

  it("returns 404 when editing another user's entry", async () => {
    await seedDiaryEntry(context.db, {
      bodyText: "not yours",
      id: "other-user-entry",
      occurredAt: "2026-06-30T00:00:00.000Z",
      userId: "someone-else"
    });

    const response = await context.server.inject({
      method: "PATCH",
      payload: { bodyDoc: createTextDocument("hijack") },
      url: "/api/diary/entries/other-user-entry"
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 when editing a note (a personal Entry that is not a diary)", async () => {
    await seedNote(context.db, {
      id: "note-not-diary",
      markdown: "a note",
      occurredAt: "2026-06-30T00:00:00.000Z",
      userId: DEFAULT_USER_ID
    });

    const response = await context.server.inject({
      method: "PATCH",
      payload: { bodyDoc: createTextDocument("edit the note as a diary") },
      url: "/api/diary/entries/note-not-diary"
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("DELETE /api/diary/entries/:id", () => {
  it("deletes the current user's entry and every facet", async () => {
    const created = await createEntry("to be deleted");

    const response = await context.server.inject({
      method: "DELETE",
      url: `/api/diary/entries/${created.id}`
    });

    expect(response.statusCode).toBe(204);
    expect((await timeline()).days).toEqual([]);
    expect(await listDiaryEntriesForUser(context.db, DEFAULT_USER_ID)).toEqual([]);
    // The owning Entry and its personal-entry facet are gone too.
    expect(await context.db.select().from(entries)).toEqual([]);
    expect(await context.db.select().from(personalEntries)).toEqual([]);
  });

  it("returns 404 for a missing entry", async () => {
    const response = await context.server.inject({
      method: "DELETE",
      url: "/api/diary/entries/missing"
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 when deleting another user's entry, which survives", async () => {
    await seedDiaryEntry(context.db, {
      bodyText: "not yours",
      id: "other-user-delete",
      occurredAt: "2026-06-30T00:00:00.000Z",
      userId: "someone-else"
    });

    const response = await context.server.inject({
      method: "DELETE",
      url: "/api/diary/entries/other-user-delete"
    });

    expect(response.statusCode).toBe(404);
    const survivors = await listDiaryEntriesForUser(context.db, "someone-else");
    expect(survivors.map((entry) => entry.id)).toEqual(["other-user-delete"]);
  });
});
