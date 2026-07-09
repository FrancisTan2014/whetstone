import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  BackfillResultDto,
  MakeDurableCardListDto,
  QuickCaptureResultDto,
  RecallItemDto
} from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { createServer } from "../../http/createServer.js";
import { entries, timelineEntries } from "../../db/schema.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import type { ProposalAttempt, ProposalProvider } from "./proposalProvider.js";

const captureText = "I wanted to say WorkInsight is back up now but I could not";

const validAttempt: ProposalAttempt = {
  modelName: "fake-model",
  generation: {
    candidates: [
      {
        type: "phrase_chunk",
        confidence: 0.9,
        reason: "a reusable status phrase",
        evidenceQuote: "WorkInsight is back up now",
        payload: {
          target: "WorkInsight is back up now",
          cue: "a service is back",
          useContext: "reporting availability",
          category: "work",
          tags: ["service-status"]
        }
      }
    ]
  }
};

type TestContext = Readonly<{
  db: DbClient;
  server: ReturnType<typeof createServer>;
}>;

let context: TestContext;

function buildContext(
  propose: ProposalProvider,
  proposeBackfill: ProposalProvider = propose
): Promise<TestContext> {
  const pglite = new PGlite();
  let sequence = 0;
  return runMigrations(pglite).then(() => {
    const db = createDbClient(pglite);
    return {
      db,
      server: createServer({
        logger: false,
        makeDurable: {
          createId: () => `id-${(sequence += 1)}`,
          db,
          now: () => new Date("2026-07-06T09:30:00.000Z"),
          propose,
          proposeBackfill
        }
      })
    };
  });
}

async function capture(text = captureText): Promise<QuickCaptureResultDto> {
  const response = await context.server.inject({
    method: "POST",
    payload: { text },
    url: "/api/makedurable/capture"
  });
  expect(response.statusCode).toBe(201);
  return response.json() as QuickCaptureResultDto;
}

async function seedDiaryCapture(): Promise<void> {
  await context.db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: "diary-history-1", type: "timeline_entry" });
    await tx.insert(timelineEntries).values({
      captureSource: "diary",
      createdAt: new Date("2026-07-06T08:30:00.000Z"),
      entryDate: "2026-07-06",
      entryId: "diary-history-1",
      inputMode: "typed",
      language: null,
      rawAudioPath: null,
      rawInputText: captureText,
      tidiedText: captureText,
      userId: DEFAULT_USER_ID
    });
  });
}

afterEach(async () => {
  await context.server.close();
});

describe("POST /api/makedurable/capture", () => {
  beforeEach(async () => {
    context = await buildContext(() => Promise.resolve(validAttempt));
  });

  it("saves a capture and returns the review card", async () => {
    const result = await capture();

    expect(result.timelineEntry.rawInputText).toBe(captureText);
    expect(result.timelineEntry.inputMode).toBe("typed");
    expect(result.card?.target).toBe("WorkInsight is back up now");
  });

  it("records a voice capture with input_mode = voice through the same route", async () => {
    const response = await context.server.inject({
      method: "POST",
      payload: { text: captureText, inputMode: "voice" },
      url: "/api/makedurable/capture"
    });

    expect(response.statusCode).toBe(201);
    const result = response.json() as QuickCaptureResultDto;
    expect(result.timelineEntry.inputMode).toBe("voice");
    expect(result.card?.target).toBe("WorkInsight is back up now");
  });

  it("rejects an unknown input mode", async () => {
    const response = await context.server.inject({
      method: "POST",
      payload: { text: captureText, inputMode: "handwritten" },
      url: "/api/makedurable/capture"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("rejects a blank capture", async () => {
    const response = await context.server.inject({
      method: "POST",
      payload: { text: "   " },
      url: "/api/makedurable/capture"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });
});

describe("GET /api/makedurable/cards", () => {
  beforeEach(async () => {
    context = await buildContext(() => Promise.resolve(validAttempt));
  });

  it("lists the pending Today cards", async () => {
    const created = await capture();

    const response = await context.server.inject({ method: "GET", url: "/api/makedurable/cards" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as MakeDurableCardListDto;
    expect(body.cards.map((card) => card.proposalCandidateId)).toEqual([
      created.card?.proposalCandidateId
    ]);
  });

  it("is empty when nothing is pending", async () => {
    const response = await context.server.inject({ method: "GET", url: "/api/makedurable/cards" });
    expect(response.json()).toEqual({ cards: [] });
  });
});

describe("POST /api/makedurable/backfill", () => {
  it("mines an un-mined capture from history into one Today card", async () => {
    // The live model proposes nothing, so the capture leaves a Timeline entry with no candidate; the
    // backfill model then finds a high-value item in it.
    context = await buildContext(
      () => Promise.resolve(null),
      () => Promise.resolve(validAttempt)
    );
    await seedDiaryCapture();

    const response = await context.server.inject({
      method: "POST",
      url: "/api/makedurable/backfill"
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as BackfillResultDto;
    expect(body.scannedCount).toBe(1);
    expect(body.card?.target).toBe("WorkInsight is back up now");

    const cards = await context.server.inject({ method: "GET", url: "/api/makedurable/cards" });
    expect((cards.json() as MakeDurableCardListDto).cards).toHaveLength(1);
  });

  it("returns a null card and zero scanned when there is no history to mine", async () => {
    context = await buildContext(() => Promise.resolve(validAttempt));

    const response = await context.server.inject({
      method: "POST",
      url: "/api/makedurable/backfill"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ card: null, scannedCount: 0 });
  });
});

describe("POST /api/makedurable/proposals/:id/review", () => {
  beforeEach(async () => {
    context = await buildContext(() => Promise.resolve(validAttempt));
  });

  async function reviewOf(
    id: string,
    body: unknown
  ): Promise<ReturnType<typeof context.server.inject>> {
    return context.server.inject({
      method: "POST",
      payload: body,
      url: `/api/makedurable/proposals/${id}/review`
    });
  }

  it("saves an approved proposal as a recall item", async () => {
    const created = await capture();
    const id = created.card?.proposalCandidateId ?? "";

    const response = await reviewOf(id, { outcome: "saved" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { recallItem: RecallItemDto };
    expect(body.recallItem.text).toBe("WorkInsight is back up now");
    expect(body.recallItem.sourceProposalCandidateId).toBe(id);

    // The card is cleared from Today after review.
    const cards = await context.server.inject({ method: "GET", url: "/api/makedurable/cards" });
    expect((cards.json() as MakeDurableCardListDto).cards).toEqual([]);
  });

  it("records a negative outcome without creating a recall item", async () => {
    const created = await capture();
    const id = created.card?.proposalCandidateId ?? "";

    const response = await reviewOf(id, { outcome: "wrong_hallucinated" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ recallItem: null });
  });

  it("returns 404 for a forged candidate id", async () => {
    const response = await reviewOf("does-not-exist", { outcome: "saved" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });

  it("returns 404 on a repeated review of an already-saved card (idempotent)", async () => {
    const created = await capture();
    const id = created.card?.proposalCandidateId ?? "";

    expect((await reviewOf(id, { outcome: "saved" })).statusCode).toBe(200);
    expect((await reviewOf(id, { outcome: "saved" })).statusCode).toBe(404);
  });

  it("rejects Edit + Save without an edited payload", async () => {
    const created = await capture();
    const id = created.card?.proposalCandidateId ?? "";

    const response = await reviewOf(id, { outcome: "edited_saved" });
    expect(response.statusCode).toBe(400);
  });
});
