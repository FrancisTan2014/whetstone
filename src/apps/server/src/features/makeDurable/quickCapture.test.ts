import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProposalPayload } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { enrollRecallItem } from "../recall/recallCommands.js";
import { getRecallItemForUser, listRecallItems } from "../recall/recallQueries.js";
import { listPendingCards } from "./cardQueries.js";
import { quickCapture, type QuickCaptureDependencies } from "./captureCommands.js";
import { listProposalCandidatesForUser } from "./proposalQueries.js";
import type { ProposalAttempt, ProposalProvider } from "./proposalProvider.js";
import { reviewProposalCard } from "./reviewCommands.js";

const userA = "user-a";
const userB = "user-b";
const t0 = new Date("2026-07-06T09:30:00.000Z");
const t1 = new Date("2026-07-06T10:00:00.000Z");

const basePayload: ProposalPayload = {
  target: "WorkInsight is back up now",
  cue: "a service is back",
  useContext: "reporting availability",
  category: "work",
  tags: ["service-status"]
};

const captureText = "I wanted to say WorkInsight is back up now but I could not";

function attempt(
  overrides: Partial<{ confidence: number; evidenceQuote: string; payload: ProposalPayload }> = {}
): ProposalAttempt {
  return {
    modelName: "fake-model",
    generation: {
      candidates: [
        {
          type: "phrase_chunk",
          confidence: overrides.confidence ?? 0.9,
          reason: "a reusable status phrase",
          evidenceQuote: overrides.evidenceQuote ?? "WorkInsight is back up now",
          payload: overrides.payload ?? basePayload
        }
      ]
    }
  };
}

const proposeNothing: ProposalProvider = () => Promise.resolve(null);
const proposeEmpty: ProposalProvider = () =>
  Promise.resolve({ generation: { candidates: [] }, modelName: "fake-model" });
function proposeWith(value: ProposalAttempt): ProposalProvider {
  return () => Promise.resolve(value);
}

type TestContext = Readonly<{ db: DbClient }>;
let context: TestContext;
let sequence = 0;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  return { db: createDbClient(pglite) };
}

function deps(propose: ProposalProvider): QuickCaptureDependencies {
  return { createId: () => `id-${(sequence += 1)}`, db: context.db, now: () => t0, propose };
}

beforeEach(async () => {
  sequence = 0;
  context = await buildContext();
});

afterEach(async () => {
  await context.db.$client.close();
});

describe("quickCapture", () => {
  it("saves the Timeline entry even when the model proposes nothing", async () => {
    const result = await quickCapture(deps(proposeNothing), { text: captureText }, userA, t0);

    expect(result.card).toBeNull();
    expect(result.timelineEntry.rawInputText).toBe(captureText);
    expect(result.timelineEntry.tidiedText).toBeNull();
    // No candidate stored when the model returns nothing.
    expect(await listProposalCandidatesForUser(context.db, userA)).toEqual([]);
  });

  it("saves the entry and shows no card when the model returns an empty proposal", async () => {
    const result = await quickCapture(deps(proposeEmpty), { text: captureText }, userA, t0);

    expect(result.card).toBeNull();
    expect(await listProposalCandidatesForUser(context.db, userA)).toEqual([]);
  });

  it("returns a review card and stores a visible candidate for a gated, non-duplicate proposal", async () => {
    const result = await quickCapture(
      deps(proposeWith(attempt())),
      { text: captureText },
      userA,
      t0
    );

    expect(result.card).toMatchObject({
      category: "work",
      cue: "a service is back",
      reason: "a reusable status phrase",
      tags: ["service-status"],
      target: "WorkInsight is back up now",
      timelineEntryId: result.timelineEntry.entryId,
      type: "phrase_chunk",
      useContext: "reporting availability"
    });

    const cards = await listPendingCards(context.db, userA);
    expect(cards.map((card) => card.proposalCandidateId)).toEqual([
      result.card?.proposalCandidateId
    ]);
    const [candidate] = await listProposalCandidatesForUser(context.db, userA);
    expect(candidate?.status).toBe("visible");
  });

  it("hides a low-confidence proposal (stored dismissed, no card, not on Today)", async () => {
    const result = await quickCapture(
      deps(proposeWith(attempt({ confidence: 0.2 }))),
      { text: captureText },
      userA,
      t0
    );

    expect(result.card).toBeNull();
    const [candidate] = await listProposalCandidatesForUser(context.db, userA);
    expect(candidate?.status).toBe("dismissed");
    expect(await listPendingCards(context.db, userA)).toEqual([]);
  });

  it("hides a proposal whose evidence is not a faithful quote of the capture", async () => {
    const result = await quickCapture(
      deps(proposeWith(attempt({ evidenceQuote: "something never written" }))),
      { text: captureText },
      userA,
      t0
    );

    expect(result.card).toBeNull();
    const [candidate] = await listProposalCandidatesForUser(context.db, userA);
    expect(candidate?.status).toBe("dismissed");
  });

  it("suppresses a duplicate (same target + same context as an existing recall item)", async () => {
    await enrollRecallItem(
      { createId: () => "existing-1", db: context.db },
      {
        kind: "phrase",
        text: "WorkInsight is back up now",
        useContext: "reporting availability"
      },
      userA,
      t0
    );

    const result = await quickCapture(
      deps(proposeWith(attempt())),
      { text: captureText },
      userA,
      t0
    );

    expect(result.card).toBeNull();
    const candidate = (await listProposalCandidatesForUser(context.db, userA))[0];
    expect(candidate?.status).toBe("dismissed");
    expect(candidate?.duplicateStatus).toBe("same_target_same_context");
  });

  it("keeps each user's captures and cards isolated", async () => {
    await quickCapture(deps(proposeWith(attempt())), { text: captureText }, userA, t0);

    expect(await listPendingCards(context.db, userB)).toEqual([]);
    expect(await listProposalCandidatesForUser(context.db, userB)).toEqual([]);
  });
});

describe("reviewProposalCard", () => {
  async function seedCard(propose: ProposalProvider = proposeWith(attempt())): Promise<string> {
    const result = await quickCapture(deps(propose), { text: captureText }, userA, t0);
    if (result.card === null) {
      throw new Error("expected a visible card");
    }
    return result.card.proposalCandidateId;
  }

  it("creates a production recall item on Save and clears the card from Today", async () => {
    const candidateId = await seedCard();

    const result = await reviewProposalCard(
      { createId: () => "recall-1", db: context.db },
      candidateId,
      { outcome: "saved" },
      userA,
      t1
    );

    expect(result.status).toBe("saved");
    if (result.status !== "saved") {
      throw new Error("expected saved");
    }
    expect(result.recallItem).toMatchObject({
      category: "work",
      kind: "phrase",
      sourceProposalCandidateId: candidateId,
      text: "WorkInsight is back up now",
      useContext: "reporting availability"
    });
    // Provenance points at the source timeline entry, and the card leaves Today.
    expect(result.recallItem.provenanceEntryId).not.toBeNull();
    expect(await getRecallItemForUser(context.db, result.recallItem.id, userA)).toEqual(
      result.recallItem
    );
    expect(await listPendingCards(context.db, userA)).toEqual([]);
  });

  it("saves the learner's edited target on Edit + Save", async () => {
    const candidateId = await seedCard();

    const result = await reviewProposalCard(
      { createId: () => "recall-1", db: context.db },
      candidateId,
      {
        outcome: "edited_saved",
        editedPayload: {
          target: "It's back up now",
          cue: "the wifi is working again",
          useContext: "telling a friend",
          category: "daily_life",
          tags: []
        }
      },
      userA,
      t1
    );

    expect(result).toMatchObject({
      recallItem: { category: "daily_life", text: "It's back up now" },
      status: "saved"
    });
  });

  it("creates no recall item on Not useful now / Wrong and dismisses the card", async () => {
    const candidateId = await seedCard();

    const result = await reviewProposalCard(
      { createId: () => "recall-1", db: context.db },
      candidateId,
      { outcome: "not_useful_now" },
      userA,
      t1
    );

    expect(result).toEqual({ recallItem: null, status: "dismissed" });
    expect(await listRecallItems(context.db, userA)).toEqual([]);
    expect(await listPendingCards(context.db, userA)).toEqual([]);
  });

  it("rejects a review of a forged or another user's candidate", async () => {
    const candidateId = await seedCard();

    expect(
      await reviewProposalCard(
        { createId: () => "recall-1", db: context.db },
        "no-such-candidate",
        { outcome: "saved" },
        userA,
        t1
      )
    ).toEqual({ status: "not_found" });

    expect(
      await reviewProposalCard(
        { createId: () => "recall-1", db: context.db },
        candidateId,
        { outcome: "saved" },
        userB,
        t1
      )
    ).toEqual({ status: "not_found" });

    expect(await listRecallItems(context.db, userA)).toEqual([]);
  });
});
