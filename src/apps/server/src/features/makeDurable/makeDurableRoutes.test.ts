import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  MakeDurableCardListDto,
  QuickCaptureResultDto,
  RecallItemDto
} from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { createServer } from "../../http/createServer.js";
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

function buildContext(propose: ProposalProvider): Promise<TestContext> {
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
          propose
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
    expect(result.card?.target).toBe("WorkInsight is back up now");
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

  it("rejects Edit + Save without an edited payload", async () => {
    const created = await capture();
    const id = created.card?.proposalCandidateId ?? "";

    const response = await reviewOf(id, { outcome: "edited_saved" });
    expect(response.statusCode).toBe(400);
  });
});
