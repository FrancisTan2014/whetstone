import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseCreateProposalCandidateRequest,
  parseCreateTimelineCaptureRequest,
  parseProposalCandidateDto,
  parseProposalReviewDto,
  parseRecordProposalReviewRequest,
  parseTimelineCaptureDto,
  type CreateProposalCandidateRequest,
  type ProposalCandidateDto
} from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { entries, proposalCandidates, timelineEntries } from "../../db/schema.js";
import { enrollRecallItem, type RecallDependencies } from "../recall/recallCommands.js";
import { getRecallItemForUser, listRecallItems } from "../recall/recallQueries.js";
import {
  createProposalCandidate,
  recordProposalReview,
  saveProposalRecallItem
} from "./proposalCommands.js";
import {
  getProposalCandidateForUser,
  listProposalCandidatesForUser,
  listProposalReviewsForCandidate
} from "./proposalQueries.js";
import { createTimelineCapture, type MakeDurableDependencies } from "./timelineCommands.js";
import { getTimelineCaptureForUser, listTimelineCapturesForUser } from "./timelineQueries.js";

const userA = "user-a";
const userB = "user-b";
const t0 = new Date("2026-07-06T09:30:00.000Z");
const t1 = new Date("2026-07-06T10:00:00.000Z");
const t2 = new Date("2026-07-07T08:00:00.000Z");

type TestContext = Readonly<{ db: DbClient; deps: MakeDurableDependencies }>;
let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  let sequence = 0;
  return { db, deps: { createId: () => `id-${(sequence += 1)}`, db } };
}

async function capture(
  userId: string,
  now: Date,
  rawInputText = "I couldn't say it"
): ReturnType<typeof createTimelineCapture> {
  const request = parseCreateTimelineCaptureRequest({ rawInputText });
  return createTimelineCapture(context.deps, request, userId, now);
}

function candidateRequest(
  overrides: Partial<CreateProposalCandidateRequest> & { timelineEntryId: string }
): CreateProposalCandidateRequest {
  return parseCreateProposalCandidateRequest({
    confidence: 0.9,
    evidenceQuote: "back up now",
    modelName: "llama3",
    payload: { cue: "a service is back", target: "WorkInsight is back up now" },
    promptVersion: "proposal-v1",
    reason: "reusable status phrase",
    type: "phrase_chunk",
    ...overrides
  });
}

// Create a candidate for one of `userId`'s captures and unwrap the success result. Used where the
// ownership gate is not the thing under test.
async function createCandidate(
  overrides: Partial<CreateProposalCandidateRequest> & { timelineEntryId: string },
  userId = userA,
  now = t1
): Promise<ProposalCandidateDto> {
  const result = await createProposalCandidate(
    context.deps,
    candidateRequest(overrides),
    userId,
    now
  );
  if (result.status !== "created") {
    throw new Error(`expected created candidate, got ${result.status}`);
  }
  return result.candidate;
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.db.$client.close();
});

describe("createTimelineCapture", () => {
  it("registers a timeline_entry Entry and a server-owned capture with defaults", async () => {
    const dto = await capture(userA, t0, "um so the deploy failed today");

    expect(dto).toEqual({
      entryId: "id-1",
      createdAt: t0.toISOString(),
      entryDate: "2026-07-06",
      inputMode: "typed",
      captureSource: "quick_capture",
      rawInputText: "um so the deploy failed today",
      tidiedText: null,
      language: null,
      rawAudioPath: null
    });
    expect(parseTimelineCaptureDto(dto)).toEqual(dto);

    // The owning Entry exists and is a first-class timeline_entry.
    const entryRows = await context.db.select().from(entries).where(eq(entries.id, "id-1"));
    expect(entryRows).toEqual([{ id: "id-1", type: "timeline_entry" }]);
  });

  it("preserves raw text verbatim and stores optional tidy/language/audio fields", async () => {
    const request = parseCreateTimelineCaptureRequest({
      captureSource: "diary",
      inputMode: "voice",
      language: "en",
      rawAudioPath: "audio/clip-1.webm",
      rawInputText: "um the, the thing broke",
      tidiedText: "the thing broke"
    });

    const dto = await createTimelineCapture(context.deps, request, userA, t0);

    expect(dto).toMatchObject({
      captureSource: "diary",
      inputMode: "voice",
      language: "en",
      rawAudioPath: "audio/clip-1.webm",
      rawInputText: "um the, the thing broke",
      tidiedText: "the thing broke"
    });
  });

  it("rejects a blank capture at the boundary", () => {
    expect(() => parseCreateTimelineCaptureRequest({ rawInputText: "   " })).toThrow();
  });
});

describe("timeline capture reads are user-scoped", () => {
  it("returns only the owner's captures, newest first, and hides another user's", async () => {
    const first = await capture(userA, t0, "first");
    const second = await capture(userA, t1, "second");
    await capture(userB, t2, "not yours");

    const list = await listTimelineCapturesForUser(context.db, userA);
    expect(list.map((row) => row.entryId)).toEqual([second.entryId, first.entryId]);

    expect(await getTimelineCaptureForUser(context.db, first.entryId, userA)).toEqual(first);
    // Another user's id (or a forged one) is not visible.
    expect(await getTimelineCaptureForUser(context.db, second.entryId, userB)).toBeUndefined();
    expect(await getTimelineCaptureForUser(context.db, "nope", userA)).toBeUndefined();
  });
});

describe("createProposalCandidate", () => {
  it("stores a gated candidate for a capture and round-trips its DTO", async () => {
    const cap = await capture(userA, t0);

    const dto = await createCandidate({ timelineEntryId: cap.entryId });

    expect(dto).toEqual({
      id: "id-2",
      timelineEntryId: cap.entryId,
      type: "phrase_chunk",
      status: "pending",
      confidence: 0.9,
      reason: "reusable status phrase",
      evidenceQuote: "back up now",
      payload: { cue: "a service is back", target: "WorkInsight is back up now" },
      duplicateStatus: "unique",
      relatedRecallItemId: null,
      noveltyReason: null,
      modelName: "llama3",
      promptVersion: "proposal-v1",
      createdAt: t1.toISOString()
    });
    expect(parseProposalCandidateDto(dto)).toEqual(dto);
  });

  it("keeps optional novelty and related-recall links when supplied", async () => {
    const cap = await capture(userA, t0);

    const dto = await createCandidate({
      duplicateStatus: "related_but_distinct",
      noveltyReason: "new context",
      status: "visible",
      timelineEntryId: cap.entryId,
      type: "couldnt_say_gap"
    });

    expect(dto).toMatchObject({
      duplicateStatus: "related_but_distinct",
      noveltyReason: "new context",
      status: "visible",
      type: "couldnt_say_gap"
    });
  });

  it("refuses to attach a candidate to another user's capture and stores nothing", async () => {
    // userB owns the capture; userA must not be able to hang a candidate off it via its known entry id.
    const foreignCapture = await capture(userB, t0, "not yours");

    const result = await createProposalCandidate(
      context.deps,
      candidateRequest({ timelineEntryId: foreignCapture.entryId }),
      userA,
      t1
    );

    expect(result).toEqual({ status: "timeline_not_found" });
    expect(await context.db.select().from(proposalCandidates)).toEqual([]);
  });

  it("rejects a candidate for a non-existent capture", async () => {
    const result = await createProposalCandidate(
      context.deps,
      candidateRequest({ timelineEntryId: "no-such-entry" }),
      userA,
      t1
    );

    expect(result).toEqual({ status: "timeline_not_found" });
  });

  it("lists and gets candidates scoped to the owner", async () => {
    const cap = await capture(userA, t0);
    const created = await createCandidate({ timelineEntryId: cap.entryId });

    expect((await listProposalCandidatesForUser(context.db, userA)).map((c) => c.id)).toEqual([
      created.id
    ]);
    expect(await getProposalCandidateForUser(context.db, created.id, userA)).toEqual(created);
    expect(await getProposalCandidateForUser(context.db, created.id, userB)).toBeUndefined();
    expect(await listProposalCandidatesForUser(context.db, userB)).toEqual([]);
  });
});

describe("recordProposalReview", () => {
  async function seedCandidate(): Promise<string> {
    const cap = await capture(userA, t0);
    const created = await createCandidate({ timelineEntryId: cap.entryId });
    return created.id;
  }

  it("records a save decision for the owner's candidate", async () => {
    const candidateId = await seedCandidate();

    const result = await recordProposalReview(
      context.deps,
      parseRecordProposalReviewRequest({ outcome: "saved", proposalCandidateId: candidateId }),
      userA,
      t2
    );

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") {
      throw new Error("expected recorded");
    }
    expect(result.review).toEqual({
      id: "id-3",
      proposalCandidateId: candidateId,
      outcome: "saved",
      feedbackTags: null,
      editedPayload: null,
      createdAt: t2.toISOString()
    });
    expect(parseProposalReviewDto(result.review)).toEqual(result.review);
  });

  it("stores feedback tags and an edited payload on an edited_saved decision", async () => {
    const candidateId = await seedCandidate();

    const result = await recordProposalReview(
      context.deps,
      parseRecordProposalReviewRequest({
        editedPayload: { target: "It's back up now" },
        feedbackTags: ["reworded"],
        outcome: "edited_saved",
        proposalCandidateId: candidateId
      }),
      userA,
      t2
    );

    expect(result).toMatchObject({
      status: "recorded",
      review: { editedPayload: { target: "It's back up now" }, feedbackTags: ["reworded"] }
    });

    const reviews = await listProposalReviewsForCandidate(context.db, candidateId, userA);
    expect(reviews.map((review) => review.outcome)).toEqual(["edited_saved"]);
  });

  it("rejects a review of another user's candidate and records nothing", async () => {
    const candidateId = await seedCandidate();

    const result = await recordProposalReview(
      context.deps,
      parseRecordProposalReviewRequest({
        outcome: "wrong_hallucinated",
        proposalCandidateId: candidateId
      }),
      userB,
      t2
    );

    expect(result).toEqual({ status: "not_found" });
    expect(await listProposalReviewsForCandidate(context.db, candidateId, userA)).toEqual([]);
  });
});

describe("saveProposalRecallItem (Make Durable save boundary)", () => {
  // The recall deps reuse the same db; a separate id sequence keeps recall ids independent of the
  // Make Durable ids so provenance/source links are unambiguous in the assertions.
  function recallDeps(): MakeDurableDependencies {
    let sequence = 0;
    return { createId: () => `recall-${(sequence += 1)}`, db: context.db };
  }

  async function seed(): Promise<{ capture: string; candidateId: string }> {
    const cap = await capture(userA, t0);
    const candidate = await createCandidate({ timelineEntryId: cap.entryId });
    return { candidateId: candidate.id, capture: cap.entryId };
  }

  it("saves a production recall item whose provenance points at the timeline entry", async () => {
    const { candidateId, capture: captureId } = await seed();

    const result = await saveProposalRecallItem(
      recallDeps(),
      candidateId,
      {
        category: "work",
        cue: "a local service is back after you restarted it",
        kind: "phrase",
        provenanceEntryId: captureId,
        tags: ["service-status"],
        text: "WorkInsight is back up now",
        useContext: "reporting service availability at work"
      },
      userA,
      t2
    );

    expect(result.status).toBe("saved");
    if (result.status !== "saved") {
      throw new Error("expected saved");
    }
    const { item } = result;
    // Existing recall invariants preserved: chunk_id null, provenance points at the timeline entry.
    expect(item.chunkId).toBeNull();
    expect(item.provenanceEntryId).toBe(captureId);
    // The source link is stamped by the boundary (never taken from the caller), plus production metadata.
    expect(item).toMatchObject({
      category: "work",
      cue: "a local service is back after you restarted it",
      sourceProposalCandidateId: candidateId,
      tags: ["service-status"],
      useContext: "reporting service availability at work"
    });

    expect(await getRecallItemForUser(context.db, item.id, userA)).toEqual(item);
  });

  it("rejects a forged proposal id and creates no recall item", async () => {
    const { capture: captureId } = await seed();

    const result = await saveProposalRecallItem(
      recallDeps(),
      "no-such-candidate",
      { kind: "phrase", provenanceEntryId: captureId, text: "x" },
      userA,
      t2
    );

    expect(result).toEqual({ status: "proposal_not_found" });
    expect(await listRecallItems(context.db, userA)).toEqual([]);
  });

  it("rejects another user's proposal id (ownership) and creates no recall item", async () => {
    const { candidateId, capture: captureId } = await seed();

    const result = await saveProposalRecallItem(
      recallDeps(),
      candidateId,
      { kind: "phrase", provenanceEntryId: captureId, text: "x" },
      userB,
      t2
    );

    expect(result).toEqual({ status: "proposal_not_found" });
    expect(await listRecallItems(context.db, userB)).toEqual([]);
  });

  it("rejects a provenance that does not match the candidate's timeline entry", async () => {
    const { candidateId } = await seed();
    const otherCapture = await capture(userA, t1, "a different capture");

    const mismatch = await saveProposalRecallItem(
      recallDeps(),
      candidateId,
      { kind: "phrase", provenanceEntryId: otherCapture.entryId, text: "x" },
      userA,
      t2
    );
    expect(mismatch).toEqual({ status: "provenance_mismatch" });

    // A missing provenance link is likewise rejected — a Make Durable save MUST be provenance-linked.
    const missing = await saveProposalRecallItem(
      recallDeps(),
      candidateId,
      { kind: "phrase", text: "x" },
      userA,
      t2
    );
    expect(missing).toEqual({ status: "provenance_mismatch" });

    expect(await listRecallItems(context.db, userA)).toEqual([]);
  });

  it("leaves production metadata null for a plain (non-Make-Durable) recall item", async () => {
    const item = await enrollRecallItem(
      recallDeps() as RecallDependencies,
      { kind: "idiom", text: "spill the beans" },
      userA,
      t0
    );

    expect(item).toMatchObject({
      category: null,
      cue: null,
      sourceProposalCandidateId: null,
      tags: null,
      useContext: null
    });
  });

  it("still points a capture's Entry row at a real timeline_entries row", async () => {
    const cap = await capture(userA, t0);

    const rows = await context.db
      .select()
      .from(timelineEntries)
      .where(eq(timelineEntries.entryId, cap.entryId));
    expect(rows).toHaveLength(1);
  });
});
