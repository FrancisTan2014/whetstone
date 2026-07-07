import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JsonObject, ProposalPayload } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { insertProposalCandidate, recordProposalReview } from "./proposalCommands.js";
import { listReviewedProposalExamples, POLICY_REVIEW_LOOKBACK } from "./proposalQueries.js";
import { createTimelineCapture } from "./timelineCommands.js";

const userA = "user-a";
const userB = "user-b";

const payload: ProposalPayload = {
  target: "roll back the deploy",
  cue: "reverting a release",
  useContext: "incident updates",
  category: "work",
  tags: ["ops"]
};

type TestContext = Readonly<{ db: DbClient }>;
let context: TestContext;
let sequence = 0;

function md(): { createId: () => string; db: DbClient } {
  return { createId: () => `id-${(sequence += 1)}`, db: context.db };
}

async function seedReview(
  options: Readonly<{
    now: Date;
    outcome: "saved" | "edited_saved" | "not_useful_now" | "wrong_hallucinated" | "ignored";
    candidatePayload?: ProposalPayload;
    editedPayload?: ProposalPayload;
    type?: "phrase_chunk" | "couldnt_say_gap" | "recurring_pattern";
    userId?: string;
  }>
): Promise<void> {
  const userId = options.userId ?? userA;
  const entry = await createTimelineCapture(
    md(),
    {
      captureSource: "quick_capture",
      inputMode: "typed",
      language: null,
      rawAudioPath: null,
      rawInputText: "a capture",
      tidiedText: null
    },
    userId,
    options.now
  );
  const candidate = await insertProposalCandidate(
    md(),
    {
      confidence: 0.9,
      duplicateStatus: "unique",
      evidenceQuote: "roll back the deploy",
      modelName: "fake",
      payload: (options.candidatePayload ?? payload) as JsonObject,
      promptVersion: "proposal-v1",
      reason: "a reusable phrase",
      relatedRecallItemId: null,
      noveltyReason: null,
      status: "dismissed",
      timelineEntryId: entry.entryId,
      type: options.type ?? "phrase_chunk"
    },
    userId,
    options.now
  );
  await recordProposalReview(
    md(),
    {
      proposalCandidateId: candidate.id,
      outcome: options.outcome,
      feedbackTags: null,
      editedPayload: (options.editedPayload ?? null) as JsonObject | null
    },
    userId,
    options.now
  );
}

beforeEach(async () => {
  sequence = 0;
  const pglite = new PGlite();
  await runMigrations(pglite);
  context = { db: createDbClient(pglite) };
});

afterEach(async () => {
  await context.db.$client.close();
});

describe("listReviewedProposalExamples (#457)", () => {
  it("distills a saved review to its candidate's decision and payload", async () => {
    await seedReview({ now: new Date("2026-07-06T09:00:00.000Z"), outcome: "saved" });

    const examples = await listReviewedProposalExamples(context.db, userA, POLICY_REVIEW_LOOKBACK);

    expect(examples).toEqual([
      {
        outcome: "saved",
        type: "phrase_chunk",
        category: "work",
        target: "roll back the deploy",
        useContext: "incident updates",
        tags: ["ops"]
      }
    ]);
  });

  it("uses the learner's edited payload for an edited_saved review", async () => {
    await seedReview({
      now: new Date("2026-07-06T09:00:00.000Z"),
      outcome: "edited_saved",
      type: "couldnt_say_gap",
      editedPayload: {
        target: "it's back up now",
        cue: "the wifi works again",
        useContext: "telling a friend",
        category: "daily_life"
      }
    });

    const [example] = await listReviewedProposalExamples(context.db, userA, POLICY_REVIEW_LOOKBACK);

    expect(example).toEqual({
      outcome: "edited_saved",
      type: "couldnt_say_gap",
      category: "daily_life",
      target: "it's back up now",
      useContext: "telling a friend",
      tags: []
    });
  });

  it("defaults tags to an empty array when the payload has none", async () => {
    await seedReview({
      now: new Date("2026-07-06T09:00:00.000Z"),
      outcome: "not_useful_now",
      candidatePayload: {
        target: "by and large",
        cue: "summarizing",
        useContext: "a summary",
        category: "reading"
      }
    });

    const [example] = await listReviewedProposalExamples(context.db, userA, POLICY_REVIEW_LOOKBACK);

    expect(example?.tags).toEqual([]);
  });

  it("returns newest first, scoped to the user, and respects the lookback limit", async () => {
    await seedReview({
      now: new Date("2026-07-06T09:00:00.000Z"),
      outcome: "saved",
      candidatePayload: { ...payload, target: "oldest" }
    });
    await seedReview({
      now: new Date("2026-07-06T10:00:00.000Z"),
      outcome: "wrong_hallucinated",
      candidatePayload: { ...payload, target: "middle" }
    });
    await seedReview({
      now: new Date("2026-07-06T11:00:00.000Z"),
      outcome: "saved",
      candidatePayload: { ...payload, target: "newest" }
    });
    await seedReview({
      now: new Date("2026-07-06T12:00:00.000Z"),
      outcome: "saved",
      userId: userB
    });

    const examples = await listReviewedProposalExamples(context.db, userA, 2);

    expect(examples.map((example) => example.target)).toEqual(["newest", "middle"]);
  });
});
