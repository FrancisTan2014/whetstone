import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { createTextDocument, documentReadableText } from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { entries } from "../../db/schema.js";
import { insertNoteInTx, insertNotePromptInTx } from "../notes/noteCommands.js";
import type { NearMatchNote } from "../notes/noteNearMatchQuery.js";
import type { ExactMaterialNote } from "../notes/noteQueries.js";
import { seedReviewCard } from "../review/reviewCardCommands.js";
import { RECALL_REQUEST_RETENTION } from "@whetstone/domain";
import {
  buildAnswerExcerpt,
  loadMaterialReviewCandidates,
  loadNearMaterialReviewCandidates
} from "./materialReviewCandidates.js";

const userId = "user-1";
const now = new Date("2026-03-01T08:00:00.000Z");

let db: DbClient;

// Seed one owned body-bearing note, optionally anchored to a block (with selected text) and/or carrying
// `cards` review cards, then return the ExactMaterialNote the candidate loader consumes.
async function seedNote(
  id: string,
  options: Readonly<{ anchorText?: string; body: string; cards?: number }>
): Promise<ExactMaterialNote> {
  const bodyDoc = createTextDocument(options.body);
  const bodyText = documentReadableText(bodyDoc);
  const anchor =
    options.anchorText === undefined
      ? null
      : {
          blockEntryId: toEntryId(`block-${id}`),
          contextSnapshot: options.anchorText,
          endBlockEntryId: toEntryId(`block-${id}`),
          selectedTextSnapshot: options.anchorText
        };

  await db.transaction(async (tx) => {
    if (anchor !== null) {
      await tx.insert(entries).values({ id: `block-${id}`, type: "block" });
    }
    await insertNoteInTx(tx, {
      anchor,
      bodyDoc,
      bodyText,
      captureSource: anchor === null ? "manual" : "reader",
      kind: "note",
      noteEntryId: toEntryId(id),
      now,
      userId
    });
    for (let index = 0; index < (options.cards ?? 0); index += 1) {
      const promptId = `${id}-prompt-${index}`;
      await insertNotePromptInTx(tx, {
        answerDoc: null,
        answerText: null,
        cueDoc: createTextDocument(`Cue ${index}`),
        cueText: `Cue ${index}`,
        noteEntryId: id,
        now,
        promptId,
        revealKind: "current_note"
      });
      await seedReviewCard(tx, {
        now,
        requestedRetention: RECALL_REQUEST_RETENTION,
        targetEntryId: promptId,
        userId
      });
    }
  });

  return {
    bodyDoc,
    bodyText,
    createdAt: now,
    noteEntryId: toEntryId(id),
    occurredAt: now
  };
}

beforeEach(async () => {
  const pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
});

describe("buildAnswerExcerpt", () => {
  it("collapses internal whitespace and returns a short body unchanged", () => {
    expect(buildAnswerExcerpt("  Merge   sort\nis\tstable.  ")).toBe("Merge sort is stable.");
  });

  it("truncates a long body to 200 characters with an ellipsis", () => {
    const excerpt = buildAnswerExcerpt("a".repeat(250));
    expect(excerpt).toHaveLength(201);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt.slice(0, 200)).toBe("a".repeat(200));
  });
});

describe("loadMaterialReviewCandidates", () => {
  it("returns an empty list without a query when there are no notes", async () => {
    expect(await loadMaterialReviewCandidates(db, userId, [])).toEqual([]);
  });

  it("enriches a cardless, unanchored note with zero cards and a null source context", async () => {
    const note = await seedNote("note-plain", { body: "Merge sort is stable." });
    expect(await loadMaterialReviewCandidates(db, userId, [note])).toEqual([
      {
        answerExcerpt: "Merge sort is stable.",
        cardCount: 0,
        noteId: "note-plain",
        sourceContext: null
      }
    ]);
  });

  it("counts a note's review cards and surfaces an anchored note's selected text, preserving order", async () => {
    const anchored = await seedNote("note-anchored", {
      anchorText: "from the textbook",
      body: "Quicksort is not stable.",
      cards: 2
    });
    const plain = await seedNote("note-plain", { body: "Merge sort is stable.", cards: 1 });

    const candidates = await loadMaterialReviewCandidates(db, userId, [anchored, plain]);
    expect(candidates).toEqual([
      {
        answerExcerpt: "Quicksort is not stable.",
        cardCount: 2,
        noteId: "note-anchored",
        sourceContext: "from the textbook"
      },
      {
        answerExcerpt: "Merge sort is stable.",
        cardCount: 1,
        noteId: "note-plain",
        sourceContext: null
      }
    ]);
  });
});

// Build the NearMatchNote the near loader consumes from a seeded note's id, its case-sensitive key, and body.
function nearNote(id: string, caseSensitiveKey: string, bodyText: string): NearMatchNote {
  return { bodyText, caseSensitiveKey, noteEntryId: toEntryId(id), score: 0.9 };
}

describe("loadNearMaterialReviewCandidates", () => {
  it("returns an empty list without a query when there are no near candidates", async () => {
    expect(
      await loadNearMaterialReviewCandidates(db, userId, createTextDocument("anything here"), [])
    ).toEqual([]);
  });

  it("enriches each near candidate with evidence and the word differences vs the drafted Answer", async () => {
    await seedNote("note-near", {
      anchorText: "from the design doc",
      body: "in term of the design",
      cards: 3
    });
    const draft = createTextDocument("in terms of the design");

    const candidates = await loadNearMaterialReviewCandidates(db, userId, draft, [
      nearNote("note-near", "in term of the design", "in term of the design")
    ]);

    expect(candidates).toEqual([
      {
        answerExcerpt: "in term of the design",
        cardCount: 3,
        differences: [{ after: "terms", before: "term" }],
        noteId: "note-near",
        sourceContext: "from the design doc"
      }
    ]);
  });
});
