import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProposalPayload } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { entries, timelineEntries } from "../../db/schema.js";
import { enrollRecallItem } from "../recall/recallCommands.js";
import { getRecallItemForUser } from "../recall/recallQueries.js";
import {
  backfillMakeDurable,
  BACKFILL_SCAN_LIMIT,
  type BackfillDependencies
} from "./backfillCommands.js";
import { listPendingCards } from "./cardQueries.js";
import { insertProposalCandidate, recordProposalReview } from "./proposalCommands.js";
import {
  listProposalCandidatesForUser,
  listProposalReviewsForCandidate
} from "./proposalQueries.js";
import type { ProposalAttempt, ProposalProvider } from "./proposalProvider.js";
import { reviewProposalCard } from "./reviewCommands.js";
import { createTimelineCapture } from "./timelineCommands.js";
import { listBackfillableCaptures } from "./timelineQueries.js";

const userA = "user-a";
const userB = "user-b";
const t0 = new Date("2026-07-06T09:30:00.000Z");
const t1 = new Date("2026-07-06T10:00:00.000Z");

// A faithful quote of every capture text used below, so the visibility gate rejects only on confidence.
const captureText = "I wanted to say WorkInsight is back up now but I could not";

const basePayload: ProposalPayload = {
  target: "WorkInsight is back up now",
  cue: "a service is back",
  useContext: "reporting availability",
  category: "work",
  tags: ["service-status"]
};

function attempt(
  overrides: Partial<{ confidence: number; evidenceQuote: string; payload: ProposalPayload }> = {}
): ProposalAttempt {
  return {
    modelName: "fake-backfill-model",
    generation: {
      candidates: [
        {
          type: "recurring_pattern",
          confidence: overrides.confidence ?? 0.9,
          reason: "a reusable production pattern",
          evidenceQuote: overrides.evidenceQuote ?? "WorkInsight is back up now",
          payload: overrides.payload ?? basePayload
        }
      ]
    }
  };
}

const emptyAttempt: ProposalAttempt = {
  generation: { candidates: [] },
  modelName: "fake-backfill-model"
};

const proposeNothing: ProposalProvider = () => Promise.resolve(null);
function proposeAlways(value: ProposalAttempt): ProposalProvider {
  return () => Promise.resolve(value);
}
// Dispatch the fake proposal on the capture text, so a test can mix "nothing here" and "high value"
// entries in one scan.
function proposeByText(byText: Readonly<Record<string, ProposalAttempt | null>>): ProposalProvider {
  return (rawText) => Promise.resolve(rawText in byText ? byText[rawText] : null);
}

type TestContext = Readonly<{ db: DbClient }>;
let context: TestContext;
let sequence = 0;

function deps(proposeBackfill: ProposalProvider): BackfillDependencies {
  return {
    createId: () => `id-${(sequence += 1)}`,
    db: context.db,
    now: () => t0,
    proposeBackfill
  };
}

async function seedCapture(text: string, now: Date, userId = userA): Promise<string> {
  const entry = await createTimelineCapture(
    { createId: () => `entry-${(sequence += 1)}`, db: context.db },
    {
      captureSource: "diary",
      inputMode: "typed",
      language: null,
      rawAudioPath: null,
      rawInputText: text,
      tidiedText: null
    },
    userId,
    now
  );
  return entry.entryId;
}

// Seed an async voice capture (#565) directly with a chosen processing status, bypassing the worker.
// `queued`/`transcribing`/`tidying`/`failed` are pending/terminal-failed states whose transcript is not
// display-ready; only a `ready` (or synchronous null-status) diary row should be mineable by backfill.
async function seedVoiceCapture(
  text: string,
  processingStatus: "queued" | "transcribing" | "tidying" | "ready" | "failed",
  now: Date,
  userId = userA
): Promise<string> {
  const entryId = `voice-${(sequence += 1)}`;
  await context.db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: entryId, type: "timeline_entry" });
    await tx.insert(timelineEntries).values({
      entryId,
      userId,
      createdAt: now,
      entryDate: now.toISOString().slice(0, 10),
      inputMode: "voice",
      captureSource: "diary",
      rawInputText: text,
      tidiedText: processingStatus === "ready" ? text : null,
      language: "en",
      rawAudioPath: `audio-${entryId}`,
      processingStatus,
      failureReason: processingStatus === "failed" ? "empty_transcript" : null
    });
  });
  return entryId;
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

describe("backfillMakeDurable", () => {
  it("surfaces one visible card from an un-mined entry and stores a visible candidate", async () => {
    const entryId = await seedCapture(captureText, t0);

    const result = await backfillMakeDurable(deps(proposeAlways(attempt())), userA, t0);

    expect(result.scannedCount).toBe(1);
    expect(result.card).toMatchObject({
      target: "WorkInsight is back up now",
      timelineEntryId: entryId,
      type: "recurring_pattern"
    });
    const [candidate] = await listProposalCandidatesForUser(context.db, userA);
    expect(candidate?.status).toBe("visible");
    expect(candidate?.timelineEntryId).toBe(entryId);
    expect(
      (await listPendingCards(context.db, userA)).map((card) => card.proposalCandidateId)
    ).toEqual([result.card?.proposalCandidateId]);
  });

  it("makes the surfaced card durable on Save with provenance to the source Timeline entry", async () => {
    const entryId = await seedCapture(captureText, t0);
    const result = await backfillMakeDurable(deps(proposeAlways(attempt())), userA, t0);
    const candidateId = result.card?.proposalCandidateId ?? "";

    const saved = await reviewProposalCard(
      { createId: () => "recall-1", db: context.db },
      candidateId,
      { outcome: "saved" },
      userA,
      t1
    );

    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") {
      throw new Error("expected saved");
    }
    expect(saved.recallItem).toMatchObject({
      kind: "pattern",
      provenanceEntryId: entryId,
      sourceProposalCandidateId: candidateId,
      text: "WorkInsight is back up now"
    });
    expect(await getRecallItemForUser(context.db, saved.recallItem.id, userA)).toEqual(
      saved.recallItem
    );
  });

  it("records review feedback and creates no recall item on Not useful now", async () => {
    await seedCapture(captureText, t0);
    const result = await backfillMakeDurable(deps(proposeAlways(attempt())), userA, t0);
    const candidateId = result.card?.proposalCandidateId ?? "";

    const dismissed = await reviewProposalCard(
      { createId: () => "review-1", db: context.db },
      candidateId,
      { outcome: "not_useful_now" },
      userA,
      t1
    );

    expect(dismissed).toEqual({ recallItem: null, status: "dismissed" });
    expect(await listProposalReviewsForCandidate(context.db, candidateId, userA)).toHaveLength(1);
    expect(await listPendingCards(context.db, userA)).toEqual([]);
  });

  it("only considers the current user's Timeline entries", async () => {
    await seedCapture(captureText, t0, userB);
    await seedCapture(captureText, t0, userA);

    const result = await backfillMakeDurable(deps(proposeAlways(attempt())), userA, t0);

    expect(result.card).not.toBeNull();
    // User B's entry was never scanned or given a candidate.
    expect(await listProposalCandidatesForUser(context.db, userB)).toEqual([]);
  });

  it("never re-mines an entry that already has a candidate (and does not call the model)", async () => {
    const entryId = await seedCapture(captureText, t0);
    await insertProposalCandidate(
      { createId: () => "existing-cand", db: context.db },
      {
        confidence: 0.9,
        duplicateStatus: "unique",
        evidenceQuote: "WorkInsight is back up now",
        modelName: "prior",
        payload: basePayload,
        promptVersion: "proposal-v1",
        reason: "already mined",
        relatedRecallItemId: null,
        noveltyReason: null,
        status: "dismissed",
        timelineEntryId: entryId,
        type: "phrase_chunk"
      },
      userA,
      t0
    );

    let calls = 0;
    const spy: ProposalProvider = () => {
      calls += 1;
      return Promise.resolve(attempt());
    };

    const result = await backfillMakeDurable(deps(spy), userA, t0);

    expect(calls).toBe(0);
    expect(result).toEqual({ card: null, scannedCount: 0 });
  });

  it("leaves history unchanged when the model is unavailable", async () => {
    await seedCapture(captureText, t0);
    await seedCapture(captureText, t1);

    const result = await backfillMakeDurable(deps(proposeNothing), userA, t0);

    expect(result).toEqual({ card: null, scannedCount: 0 });
    expect(await listProposalCandidatesForUser(context.db, userA)).toEqual([]);
    // No scan marker is written for a null attempt, so both entries stay eligible for a later run.
    expect(await listBackfillableCaptures(context.db, userA, BACKFILL_SCAN_LIMIT)).toHaveLength(2);
  });

  it("skips an entry the model finds nothing in and keeps scanning to a high-value one", async () => {
    const chatty = "just a chatty note with nothing durable";
    await seedCapture(chatty, t0);
    const goldId = await seedCapture(captureText, t1);

    const result = await backfillMakeDurable(
      deps(proposeByText({ [chatty]: emptyAttempt, [captureText]: attempt() })),
      userA,
      t0
    );

    expect(result.scannedCount).toBe(2);
    expect(result.card?.timelineEntryId).toBe(goldId);
    // Only the gold entry got a candidate; the chatty entry stored nothing.
    const candidates = await listProposalCandidatesForUser(context.db, userA);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.timelineEntryId).toBe(goldId);
  });

  it("stores a gated-out low-confidence candidate as dismissed and continues to a stronger one", async () => {
    const weak = "a low-value WorkInsight is back up now aside";
    await seedCapture(weak, t0);
    const strongId = await seedCapture(captureText, t1);

    const result = await backfillMakeDurable(
      deps(
        proposeByText({
          [weak]: attempt({ confidence: 0.2, evidenceQuote: "WorkInsight is back up now" }),
          [captureText]: attempt()
        })
      ),
      userA,
      t0
    );

    expect(result.scannedCount).toBe(2);
    expect(result.card?.timelineEntryId).toBe(strongId);
    const statuses = (await listProposalCandidatesForUser(context.db, userA))
      .map((candidate) => candidate.status)
      .sort();
    expect(statuses).toEqual(["dismissed", "visible"]);
    expect((await listPendingCards(context.db, userA)).map((card) => card.timelineEntryId)).toEqual(
      [strongId]
    );
  });

  it("suppresses a duplicate of an existing recall item (dismissed, no card)", async () => {
    await enrollRecallItem(
      { createId: () => "existing-recall", db: context.db },
      { kind: "phrase", text: "WorkInsight is back up now", useContext: "reporting availability" },
      userA,
      t0
    );
    await seedCapture(captureText, t0);

    const result = await backfillMakeDurable(deps(proposeAlways(attempt())), userA, t0);

    expect(result.card).toBeNull();
    const [candidate] = await listProposalCandidatesForUser(context.db, userA);
    expect(candidate?.status).toBe("dismissed");
    expect(candidate?.duplicateStatus).toBe("same_target_same_context");
  });

  it("holds a gated-in proposal as pending (no new visible card) when Today already shows a card", async () => {
    await seedCapture(captureText, t0);
    const first = await backfillMakeDurable(deps(proposeAlways(attempt())), userA, t0);
    expect(first.card).not.toBeNull();

    await seedCapture(captureText, t1);
    const second = await backfillMakeDurable(deps(proposeAlways(attempt())), userA, t1);

    expect(second).toEqual({ card: null, scannedCount: 1 });
    const statuses = (await listProposalCandidatesForUser(context.db, userA))
      .map((candidate) => candidate.status)
      .sort();
    expect(statuses).toEqual(["pending", "visible"]);
    // Today still shows exactly the first card.
    expect(
      (await listPendingCards(context.db, userA)).map((card) => card.proposalCandidateId)
    ).toEqual([first.card?.proposalCandidateId]);
  });

  it("passes the user's existing recall into the backfill provider (retrieve-before-generate)", async () => {
    await enrollRecallItem(
      { createId: () => "existing-recall", db: context.db },
      { kind: "phrase", text: "by and large", useContext: "summarizing" },
      userA,
      t0
    );
    await seedCapture(captureText, t0);

    let seen: unknown;
    const spy: ProposalProvider = (_rawText, existing) => {
      seen = existing;
      return Promise.resolve(null);
    };

    await backfillMakeDurable(deps(spy), userA, t0);

    expect(seen).toEqual([{ target: "by and large", useContext: "summarizing" }]);
  });

  it("threads reviewed-example policy into the backfill provider (#457)", async () => {
    // A separate reviewed entry provides review history; it already has a candidate, so it is not itself
    // re-mined — it only supplies policy.
    const reviewedEntry = await seedCapture("a previously reviewed capture", t0);
    const reviewedCandidate = await insertProposalCandidate(
      { createId: () => "reviewed-cand", db: context.db },
      {
        confidence: 0.9,
        duplicateStatus: "unique",
        evidenceQuote: "WorkInsight is back up now",
        modelName: "fake",
        payload: basePayload as unknown as Record<string, unknown>,
        promptVersion: "proposal-v1",
        reason: "a reusable phrase",
        relatedRecallItemId: null,
        noveltyReason: null,
        status: "dismissed",
        timelineEntryId: reviewedEntry,
        type: "phrase_chunk"
      },
      userA,
      t0
    );
    await recordProposalReview(
      { createId: () => "review-1", db: context.db },
      {
        proposalCandidateId: reviewedCandidate.id,
        outcome: "saved",
        feedbackTags: null,
        editedPayload: null
      },
      userA,
      t0
    );
    await seedCapture(captureText, t1);

    let seen: ReadonlyArray<{ outcome: string; target: string }> = [];
    const spy: ProposalProvider = (_rawText, _existing, examples) => {
      seen = (examples ?? []) as ReadonlyArray<{ outcome: string; target: string }>;
      return Promise.resolve(null);
    };
    await backfillMakeDurable(deps(spy), userA, t1);

    expect(seen).toContainEqual(
      expect.objectContaining({ outcome: "saved", target: "WorkInsight is back up now" })
    );
  });

  it("scans at most BACKFILL_SCAN_LIMIT entries per run", async () => {
    for (let i = 0; i <= BACKFILL_SCAN_LIMIT; i += 1) {
      await seedCapture(`note ${i}`, new Date(t0.getTime() + i * 1000));
    }

    const result = await backfillMakeDurable(deps(proposeAlways(emptyAttempt)), userA, t0);

    expect(result.card).toBeNull();
    expect(result.scannedCount).toBe(BACKFILL_SCAN_LIMIT);
  });

  it("does not re-scan an entry the model found nothing in on a later run (durable marker)", async () => {
    await seedCapture(captureText, t0);

    const first = await backfillMakeDurable(deps(proposeAlways(emptyAttempt)), userA, t0);
    expect(first).toEqual({ card: null, scannedCount: 1 });

    let calls = 0;
    const spy: ProposalProvider = () => {
      calls += 1;
      return Promise.resolve(emptyAttempt);
    };
    const second = await backfillMakeDurable(deps(spy), userA, t1);

    // The marker makes the entry ineligible, so the model is never asked about it again.
    expect(calls).toBe(0);
    expect(second).toEqual({ card: null, scannedCount: 0 });
  });

  it("reaches a high-value entry beyond the first BACKFILL_SCAN_LIMIT across runs", async () => {
    for (let i = 0; i < BACKFILL_SCAN_LIMIT; i += 1) {
      await seedCapture(`chatty note ${i}`, new Date(t0.getTime() + i * 1000));
    }
    const goldId = await seedCapture(
      captureText,
      new Date(t0.getTime() + (BACKFILL_SCAN_LIMIT + 1) * 1000)
    );
    // Empty for every chatty note, high value only for the gold capture.
    const provider: ProposalProvider = (rawText) =>
      Promise.resolve(rawText === captureText ? attempt() : emptyAttempt);

    // Run 1 exhausts the per-run limit on the empty entries; the gold entry (position 26) is unreachable.
    const first = await backfillMakeDurable(deps(provider), userA, t0);
    expect(first).toEqual({ card: null, scannedCount: BACKFILL_SCAN_LIMIT });
    expect(await listProposalCandidatesForUser(context.db, userA)).toEqual([]);

    // Run 2: the 25 marked entries are skipped, so the gold entry is now reached and surfaced.
    const second = await backfillMakeDurable(deps(provider), userA, t1);
    expect(second.card?.timelineEntryId).toBe(goldId);
    const [candidate] = await listProposalCandidatesForUser(context.db, userA);
    expect(candidate?.status).toBe("visible");
  });

  it("excludes pending and failed voice captures from the backfill-eligible set (#565)", async () => {
    await seedVoiceCapture("queued clip", "queued", t0);
    await seedVoiceCapture("transcribing clip", "transcribing", t0);
    await seedVoiceCapture("tidying clip", "tidying", t0);
    await seedVoiceCapture("failed clip", "failed", t0);
    const readyId = await seedVoiceCapture("a ready voice capture", "ready", t1);
    const syncId = await seedCapture("a synchronous diary note", t1);

    const eligible = await listBackfillableCaptures(context.db, userA, BACKFILL_SCAN_LIMIT);

    // Only the display-ready voice capture and the synchronous (null-status) diary row qualify.
    expect(eligible.map((capture) => capture.entryId).sort()).toEqual([readyId, syncId].sort());
  });

  it("never mines a pending voice capture, keeping it mineable once ready (#565)", async () => {
    const voiceId = await seedVoiceCapture(captureText, "queued", t0);

    // A provider that WOULD propose for this exact text — proving exclusion is by status, not content.
    let calls = 0;
    const provider: ProposalProvider = (rawText) => {
      calls += 1;
      return Promise.resolve(rawText === captureText ? attempt() : null);
    };

    const pending = await backfillMakeDurable(deps(provider), userA, t0);

    expect(pending).toEqual({ card: null, scannedCount: 0 });
    // The pending capture was never handed to the model, nor marked scanned or candidated.
    expect(calls).toBe(0);
    expect(await listProposalCandidatesForUser(context.db, userA)).toEqual([]);

    // Once the worker marks it ready, the real transcript is still eligible and gets mined.
    await context.db
      .update(timelineEntries)
      .set({ processingStatus: "ready", tidiedText: captureText })
      .where(eq(timelineEntries.entryId, voiceId));

    const afterReady = await backfillMakeDurable(deps(provider), userA, t1);
    expect(afterReady.card?.timelineEntryId).toBe(voiceId);
  });
});
