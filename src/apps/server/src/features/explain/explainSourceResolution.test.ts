import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { toEntryId } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { authors, blocks, entries, readingUnits, workMeta } from "../../db/schema.js";
import { resolveExplainSource, type ExplainSelectionRequest } from "./explainSourceResolution.js";

let db: DbClient;

const AUTHOR_ID = "author-1";
const WORK_ID = "work-1";
const UNIT_ID = "unit-1";
const BLOCK_ID = "block-1";

async function seedWork(params: {
  language?: "en" | "zh-CN" | "zh-TW";
  plaintext: string;
  deleted?: boolean;
}): Promise<void> {
  await db.insert(entries).values([
    { id: WORK_ID, type: "work" },
    { id: UNIT_ID, type: "reading_unit" },
    { id: BLOCK_ID, type: "block" }
  ]);
  await db.insert(authors).values({ id: AUTHOR_ID, name: "Author" });
  await db.insert(workMeta).values({
    authorId: AUTHOR_ID,
    entryId: WORK_ID,
    language: params.language ?? "en",
    origin: "manual",
    title: "A Work",
    workType: "essay"
  });
  await db
    .insert(readingUnits)
    .values({ entryId: UNIT_ID, orderIndex: 0, title: "Unit One", workEntryId: WORK_ID });
  await db.insert(blocks).values({
    blockType: "paragraph",
    deletedAt: params.deleted === true ? new Date() : null,
    entryId: BLOCK_ID,
    mdastJson: { children: [], type: "paragraph" },
    orderIndex: 0,
    plaintext: params.plaintext,
    readingUnitEntryId: UNIT_ID,
    workEntryId: WORK_ID
  });
}

function selectionRequest(
  overrides: Partial<ExplainSelectionRequest> = {}
): ExplainSelectionRequest {
  return {
    blockEntryId: toEntryId(BLOCK_ID),
    endOffset: 5,
    selectedText: "hello",
    startOffset: 0,
    workEntryId: toEntryId(WORK_ID),
    ...overrides
  };
}

beforeEach(async () => {
  const pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
});

describe("resolveExplainSource — happy path", () => {
  it("resolves the canonical context, headword, language, and content revision", async () => {
    await seedWork({ language: "en", plaintext: "hello world, this is a test paragraph." });

    const outcome = await resolveExplainSource(db, selectionRequest());

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.source.headword).toBe("hello");
      expect(outcome.source.language).toBe("en");
      expect(outcome.source.contentRevision).toBe(0);
      expect(outcome.source.context).toContain("hello world, this is a test paragraph.");
    }
  });

  it("resolves a Chinese Work to the zh linguistic profile", async () => {
    await seedWork({ language: "zh-CN", plaintext: "你好，这是一个测试段落。" });

    const outcome = await resolveExplainSource(
      db,
      selectionRequest({ endOffset: 2, selectedText: "你好" })
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.source.language).toBe("zh");
      expect(outcome.source.headword).toBe("你好");
    }
  });

  it("trims only surrounding whitespace from the returned headword, never internal characters", async () => {
    const plaintext = "prefix  the term  suffix";
    await seedWork({ plaintext });
    const startOffset = plaintext.indexOf("  the term  ");
    const selectedText = "  the term  ";
    const endOffset = startOffset + selectedText.length;

    const outcome = await resolveExplainSource(
      db,
      selectionRequest({ endOffset, selectedText, startOffset })
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.source.headword).toBe("the term");
    }
  });

  it("gives a term near the END of a long block real preceding context, not a truncated stub", async () => {
    const prefix = "Alpha beta gamma delta epsilon zeta eta theta iota kappa. ".repeat(40);
    const plaintext = `${prefix}TARGETWORD`;
    await seedWork({ plaintext });

    const outcome = await resolveExplainSource(
      db,
      selectionRequest({
        endOffset: plaintext.length,
        selectedText: "TARGETWORD",
        startOffset: prefix.length
      })
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.source.context.endsWith("TARGETWORD")).toBe(true);
      expect(outcome.source.context.length).toBeGreaterThan(200);
      expect(outcome.source.context).not.toBe(plaintext);
    }
  });

  it("resolves a selection containing a surrogate-pair (astral) character exactly", async () => {
    // U+1F600 (😀) is a surrogate pair — two UTF-16 code units — exercising the same code-unit offset
    // convention note anchors use, never a codepoint-aware adjustment.
    const plaintext = "before 😀 after";
    await seedWork({ plaintext });
    const emojiStart = plaintext.indexOf("😀");
    const emojiEnd = emojiStart + "😀".length;

    const outcome = await resolveExplainSource(
      db,
      selectionRequest({ endOffset: emojiEnd, selectedText: "😀", startOffset: emojiStart })
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.source.headword).toBe("😀");
    }
  });
});

describe("resolveExplainSource — not found", () => {
  it("reports not_found for a wrong Work id", async () => {
    await seedWork({ plaintext: "hello world" });

    const outcome = await resolveExplainSource(
      db,
      selectionRequest({ workEntryId: toEntryId("no-such-work") })
    );

    expect(outcome).toEqual({ status: "not_found" });
  });

  it("reports not_found for a wrong block id", async () => {
    await seedWork({ plaintext: "hello world" });

    const outcome = await resolveExplainSource(
      db,
      selectionRequest({ blockEntryId: toEntryId("no-such-block") })
    );

    expect(outcome).toEqual({ status: "not_found" });
  });

  it("reports not_found for a soft-deleted block", async () => {
    await seedWork({ deleted: true, plaintext: "hello world" });

    const outcome = await resolveExplainSource(db, selectionRequest());

    expect(outcome).toEqual({ status: "not_found" });
  });

  it("reports not_found when the block belongs to a different Work than named", async () => {
    await seedWork({ plaintext: "hello world" });
    await db.insert(entries).values([{ id: "other-work", type: "work" }]);
    await db.insert(workMeta).values({
      authorId: AUTHOR_ID,
      entryId: "other-work",
      language: "en",
      origin: "manual",
      title: "Other Work",
      workType: "essay"
    });

    const outcome = await resolveExplainSource(
      db,
      selectionRequest({ workEntryId: toEntryId("other-work") })
    );

    expect(outcome).toEqual({ status: "not_found" });
  });
});

describe("resolveExplainSource — stale selection", () => {
  it("reports stale_selection when the offsets no longer match the block's plaintext", async () => {
    await seedWork({ plaintext: "hello world" });

    const outcome = await resolveExplainSource(
      db,
      selectionRequest({ endOffset: 11, selectedText: "world" })
    );

    expect(outcome).toEqual({ status: "stale_selection" });
  });

  it("reports stale_selection when the offsets exceed the block's current (shrunk) length", async () => {
    await seedWork({ plaintext: "hi" });

    const outcome = await resolveExplainSource(db, selectionRequest());

    expect(outcome).toEqual({ status: "stale_selection" });
  });

  it("reports stale_selection for a whitespace-only difference the client no longer matches", async () => {
    await seedWork({ plaintext: "hello  world" });

    const outcome = await resolveExplainSource(
      db,
      selectionRequest({ endOffset: 11, selectedText: "hello world" })
    );

    expect(outcome).toEqual({ status: "stale_selection" });
  });

  it("never substitutes an unrelated passage for a stale selection", async () => {
    await seedWork({ plaintext: "completely different content now" });

    const outcome = await resolveExplainSource(db, selectionRequest());

    expect(outcome.status).toBe("stale_selection");
  });
});
