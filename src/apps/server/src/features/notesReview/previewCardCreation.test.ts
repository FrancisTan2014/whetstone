import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTextDocument } from "@whetstone/document";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  cardCreationAttempts,
  cardCreationReceipts,
  entryLinks,
  memoryPrompts,
  notes,
  reviewCards,
  reviewEvents
} from "../../db/schema.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import type {
  LexicalNoteRelations,
  LexicalOutcome,
  LexicalRelationService,
  SenseResolution
} from "../lexical/lexicalRelationService.js";
import { createDirectCard, type CreateDirectCardDependencies } from "./createDirectCard.js";
import {
  previewCardCreation,
  type PreviewCardCreationDependencies,
  type PreviewCardCreationRequest
} from "./previewCardCreation.js";

const now = new Date("2026-03-01T08:00:00.000Z");
const otherUser = "user-other";
const ttlMs = 30 * 60 * 1000;

let db: DbClient;
let clock: Date;
let sequence: number;

// A fake lexical service so the command's related-material branches are driven deterministically without
// booting WordNet. The command reaches lexical only through this injected boundary (design rule 8), so a fake
// is faithful, not a shortcut.
function fakeLexical(
  over: Partial<{
    senses: LexicalOutcome<SenseResolution>;
    relations: LexicalOutcome<LexicalNoteRelations>;
  }> = {}
): LexicalRelationService {
  return {
    resolveSenses: async () => over.senses ?? { kind: "not_found" },
    relateNotes: async () => over.relations ?? { kind: "not_found" }
  };
}

function buildDeps(lexical: LexicalRelationService = fakeLexical()): PreviewCardCreationDependencies {
  return {
    attemptTtlMs: ttlMs,
    createId: () => `attempt-${(sequence += 1)}`,
    db,
    lexical,
    now: () => clock
  };
}

// Seed real saved material through the canonical save so exact/near matching has something to find. Uses its
// own id space so a seeded note id never collides with a staged attempt id.
function directCardDeps(): CreateDirectCardDependencies {
  return {
    attemptTtlMs: ttlMs,
    createId: () => `seed-${(sequence += 1)}`,
    db,
    now: () => clock
  };
}

async function seedMaterial(answer: string, submissionId: string): Promise<string> {
  const result = await createDirectCard(directCardDeps(), DEFAULT_USER_ID, {
    submissionId,
    questionDoc: createTextDocument("Seed question?"),
    answerDoc: createTextDocument(answer),
    target: { kind: "current_note" }
  });
  if (result.status !== "created") {
    throw new Error(`expected seeded card, got ${result.status}`);
  }
  return result.result.noteId;
}

function request(over: Partial<PreviewCardCreationRequest> = {}): PreviewCardCreationRequest {
  return {
    submissionId: "req-1",
    questionDoc: createTextDocument("Which sorting algorithm is stable?"),
    answerDoc: createTextDocument("Merge sort is stable and O(n log n)."),
    target: { kind: "current_note" },
    sense: null,
    ...over
  };
}

// A structurally valid document whose readable text is only whitespace, to drive the blank gate.
const blankDoc = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "   " }] }]
} as unknown as PreviewCardCreationRequest["questionDoc"];

const listAttempts = () => db.select().from(cardCreationAttempts);
const listNotes = () => db.select().from(notes);

async function learningRowCounts(): Promise<Record<string, number>> {
  const [n, p, c, e, r, l] = await Promise.all([
    db.select().from(notes),
    db.select().from(memoryPrompts),
    db.select().from(reviewCards),
    db.select().from(reviewEvents),
    db.select().from(cardCreationReceipts),
    db.select().from(entryLinks)
  ]);
  return {
    cards: c.length,
    events: e.length,
    links: l.length,
    notes: n.length,
    prompts: p.length,
    receipts: r.length
  };
}

beforeEach(async () => {
  const pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
  clock = now;
  sequence = 0;
});

afterEach(async () => {
  // PGlite instances are per-test and garbage-collected; nothing to close explicitly.
});

describe("previewCardCreation", () => {
  it("stages one opaque mcp attempt and renders the card without writing learning state", async () => {
    const before = await learningRowCounts();
    const result = await previewCardCreation(buildDeps(), DEFAULT_USER_ID, request());

    expect(result.status).toBe("previewed");
    if (result.status !== "previewed") throw new Error("expected previewed");
    expect(result.attemptId).toBe("attempt-1");
    expect(result.approvalRequired).toBe(true);
    expect(result.nextAction).toBe("present_preview_and_request_approval");
    expect(result.expiresAt).toBe(new Date(now.getTime() + ttlMs).toISOString());
    expect(result.renderedCard).toEqual({
      question: "Which sorting algorithm is stable?",
      answer: "Merge sort is stable and O(n log n).",
      successCheck: null
    });
    expect(result.candidates).toEqual([]);
    expect(result.nearCandidates).toEqual([]);
    expect(result.relatedMaterial).toEqual({ mode: "senses", senses: { status: "not_found" } });

    // Exactly one staged attempt, and it is an mcp attempt with the draft payload persisted.
    const attempts = await listAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ source: "mcp", state: "pending", userId: DEFAULT_USER_ID });
    expect(attempts[0]!.draftPayload).not.toBeNull();

    // No learning row of any kind was created.
    expect(await learningRowCounts()).toEqual(before);
  });

  it("renders the success check when the draft grades against one", async () => {
    const result = await previewCardCreation(
      buildDeps(),
      DEFAULT_USER_ID,
      request({
        target: {
          kind: "expected_response",
          successCheckDoc: createTextDocument("Names merge sort and its stability.")
        }
      })
    );
    if (result.status !== "previewed") throw new Error("expected previewed");
    expect(result.renderedCard.successCheck).toBe("Names merge sort and its stability.");
  });

  it("returns exact corpus candidates without creating a card", async () => {
    const answer = "Merge sort is stable and O(n log n).";
    const seededId = await seedMaterial(answer, "seed-exact");
    const notesBefore = (await listNotes()).length;

    const result = await previewCardCreation(buildDeps(), DEFAULT_USER_ID, request({ answerDoc: createTextDocument(answer) }));
    if (result.status !== "previewed") throw new Error("expected previewed");
    expect(result.candidates.map((candidate) => candidate.noteId)).toEqual([seededId]);
    expect(result.nearCandidates).toEqual([]);
    // The preview created no additional note.
    expect((await listNotes()).length).toBe(notesBefore);
  });

  it("returns near corpus candidates with factual differences", async () => {
    const seededId = await seedMaterial("in term of the design", "seed-near");
    const result = await previewCardCreation(
      buildDeps(),
      DEFAULT_USER_ID,
      request({ answerDoc: createTextDocument("in terms of the design") })
    );
    if (result.status !== "previewed") throw new Error("expected previewed");
    expect(result.candidates).toEqual([]);
    expect(result.nearCandidates).toEqual([
      {
        answerExcerpt: "in term of the design",
        cardCount: 1,
        differences: [{ after: "terms", before: "term" }],
        noteId: seededId,
        sourceContext: null
      }
    ]);
  });

  it.each([
    ["invalid_question", { questionDoc: blankDoc }],
    ["invalid_answer", { answerDoc: blankDoc }],
    [
      "invalid_success_check",
      { target: { kind: "expected_response", successCheckDoc: blankDoc } as PreviewCardCreationRequest["target"] }
    ]
  ])("rejects a %s draft before staging anything", async (status, over) => {
    const result = await previewCardCreation(buildDeps(), DEFAULT_USER_ID, request(over));
    expect(result).toEqual({ status });
    expect(await listAttempts()).toHaveLength(0);
  });

  it("replays the same live attempt for an identical repeat request", async () => {
    const deps = buildDeps();
    const first = await previewCardCreation(deps, DEFAULT_USER_ID, request());
    const second = await previewCardCreation(deps, DEFAULT_USER_ID, request());
    if (first.status !== "previewed" || second.status !== "previewed") {
      throw new Error("expected previewed");
    }
    expect(second.attemptId).toBe(first.attemptId);
    expect(second.revision).toBe(first.revision);
    expect(await listAttempts()).toHaveLength(1);
  });

  it("refreshes the replayed attempt's evidence and bumps the fence when the corpus changed", async () => {
    const answer = "Merge sort is stable and O(n log n).";
    const deps = buildDeps();
    const first = await previewCardCreation(deps, DEFAULT_USER_ID, request({ answerDoc: createTextDocument(answer) }));
    if (first.status !== "previewed") throw new Error("expected previewed");
    expect(first.candidates).toEqual([]);

    // A matching note appears after the first preview; a repeat of the SAME request must refresh the evidence.
    const seededId = await seedMaterial(answer, "seed-late");
    const second = await previewCardCreation(deps, DEFAULT_USER_ID, request({ answerDoc: createTextDocument(answer) }));
    if (second.status !== "previewed") throw new Error("expected previewed");
    expect(second.attemptId).toBe(first.attemptId);
    expect(second.candidates.map((candidate) => candidate.noteId)).toEqual([seededId]);
    expect(second.revision).toBe(first.revision + 1);
    expect(second.candidateFingerprint).not.toBe(first.candidateFingerprint);
  });

  it("reports changed_payload when the same request id carries a different draft", async () => {
    const deps = buildDeps();
    const first = await previewCardCreation(deps, DEFAULT_USER_ID, request());
    if (first.status !== "previewed") throw new Error("expected previewed");

    const conflict = await previewCardCreation(
      deps,
      DEFAULT_USER_ID,
      request({ answerDoc: createTextDocument("A different answer entirely.") })
    );
    expect(conflict).toEqual({ status: "changed_payload" });
    // The original attempt is untouched.
    const attempts = await listAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.id).toBe(first.attemptId);
  });

  it("sweeps an expired attempt and stages a fresh one for the same request, never resurrecting it", async () => {
    const deps = buildDeps();
    const first = await previewCardCreation(deps, DEFAULT_USER_ID, request());
    if (first.status !== "previewed") throw new Error("expected previewed");

    // Advance past the TTL: the lapsed attempt is swept and a brand-new attempt id is minted.
    clock = new Date(now.getTime() + ttlMs + 1);
    const second = await previewCardCreation(deps, DEFAULT_USER_ID, request());
    if (second.status !== "previewed") throw new Error("expected previewed");
    expect(second.attemptId).not.toBe(first.attemptId);
    const attempts = await listAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.id).toBe(second.attemptId);
  });

  it("scopes attempts and candidates to the requesting owner", async () => {
    // Owner A saves material and previews it.
    const answer = "Merge sort is stable and O(n log n).";
    await seedMaterial(answer, "seed-owner");
    const deps = buildDeps();
    const mine = await previewCardCreation(deps, DEFAULT_USER_ID, request({ answerDoc: createTextDocument(answer) }));
    if (mine.status !== "previewed") throw new Error("expected previewed");
    expect(mine.candidates).toHaveLength(1);

    // Owner B, same request id and draft: gets their OWN attempt and sees none of A's material.
    const theirs = await previewCardCreation(deps, otherUser, request({ answerDoc: createTextDocument(answer) }));
    if (theirs.status !== "previewed") throw new Error("expected previewed");
    expect(theirs.attemptId).not.toBe(mine.attemptId);
    expect(theirs.candidates).toEqual([]);

    const attempts = await listAttempts();
    expect(attempts.map((attempt) => attempt.userId).sort()).toEqual([DEFAULT_USER_ID, otherUser].sort());
  });

  it("returns sense choices to select from when no sense is supplied", async () => {
    const lexical = fakeLexical({
      senses: {
        kind: "found",
        value: {
          surface: "bear",
          senses: [
            {
              offset: "02133435",
              partOfSpeech: "noun",
              definition: "a large mammal",
              examples: ["the bear roared"],
              lemmas: ["bear"]
            }
          ]
        }
      }
    });
    const result = await previewCardCreation(buildDeps(lexical), DEFAULT_USER_ID, request());
    if (result.status !== "previewed") throw new Error("expected previewed");
    expect(result.relatedMaterial).toEqual({
      mode: "senses",
      senses: {
        status: "found",
        surface: "bear",
        senses: [
          {
            offset: "02133435",
            partOfSpeech: "noun",
            definition: "a large mammal",
            examples: ["the bear roared"],
            lemmas: ["bear"]
          }
        ]
      }
    });
  });

  it("returns related saved notes under a selected sense", async () => {
    const lexical = fakeLexical({
      relations: {
        kind: "found",
        value: { surface: "bear", selectedLemma: "bear", groups: [] }
      }
    });
    const result = await previewCardCreation(
      buildDeps(lexical),
      DEFAULT_USER_ID,
      request({ sense: { offset: "02133435", partOfSpeech: "verb" } })
    );
    if (result.status !== "previewed") throw new Error("expected previewed");
    expect(result.relatedMaterial).toEqual({
      mode: "relations",
      relations: {
        status: "found",
        surface: "bear",
        selectedLemma: "bear",
        partOfSpeech: "verb",
        groups: []
      }
    });
  });

  it("passes a non-found relations outcome straight through", async () => {
    const lexical = fakeLexical({ relations: { kind: "unavailable" } });
    const result = await previewCardCreation(
      buildDeps(lexical),
      DEFAULT_USER_ID,
      request({ sense: { offset: "02133435", partOfSpeech: "verb" } })
    );
    if (result.status !== "previewed") throw new Error("expected previewed");
    expect(result.relatedMaterial).toEqual({ mode: "relations", relations: { status: "unavailable" } });
  });
});
