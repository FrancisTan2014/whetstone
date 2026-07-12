import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ImportMemoryResultDto,
  MemoryDepositDto,
  MemoryNoteDetailDto,
  MemoryNoteListDto,
  MemoryPromptCardDto,
  MemoryPromptDto
} from "@whetstone/contracts";
import { applyRating, newReviewState } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { memoryPromptReviews, memoryPrompts } from "../../db/schema.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import { depositMemory } from "./memoryCommands.js";
import type { MemoryRouteDependencies } from "./memoryRoutes.js";

const otherUser = "user-other";
const day = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-01-01T00:00:00.000Z");
const at = (days: number): Date => new Date(t0.getTime() + days * day);

type TestContext = Readonly<{
  db: DbClient;
  memory: MemoryRouteDependencies;
  server: ReturnType<typeof createServer>;
  setNow: (when: Date) => void;
}>;

let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);

  let now = t0;
  let sequence = 0;
  const memory: MemoryRouteDependencies = {
    createId: () => `id-${(sequence += 1)}`,
    db,
    now: () => now
  };

  return {
    db,
    memory,
    server: createServer({ logger: false, recall: memory }),
    setNow: (when) => {
      now = when;
    }
  };
}

// Seed one scheduled prompt (cue + answer) whose card is due at `depositedAt`, for the given user.
async function seedScheduled(cueText: string, userId: string, depositedAt: Date): Promise<string> {
  const deposit = await depositMemory(
    context.memory,
    {
      captureSource: "practice",
      noteText: cueText,
      prompts: [{ cueText, answerText: `answer:${cueText}` }]
    },
    userId,
    depositedAt
  );
  return deposit.prompts[0]!.promptId;
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.db.$client.close();
});

async function getDue(): Promise<ReadonlyArray<MemoryPromptCardDto>> {
  const response = await context.server.inject({ method: "GET", url: "/api/recall/due" });
  expect(response.statusCode).toBe(200);
  return (response.json() as { items: ReadonlyArray<MemoryPromptCardDto> }).items;
}

describe("GET /api/recall/due", () => {
  it("lists only the current user's due prompts, soonest first, excluding not-yet-due and other users'", async () => {
    const early = await seedScheduled("early", DEFAULT_USER_ID, at(-2));
    const mid = await seedScheduled("mid", DEFAULT_USER_ID, at(-1));
    await seedScheduled("future", DEFAULT_USER_ID, at(2));
    await seedScheduled("theirs", otherUser, at(-2));

    context.setNow(at(0));
    const items = await getDue();

    expect(items.map((item) => item.promptId)).toEqual([early, mid]);
    expect(items[0]?.answerText).toBe("answer:early");
  });

  it("caps today's batch so a backlog never becomes a wall", async () => {
    for (let index = 0; index < 25; index += 1) {
      await seedScheduled(`due-${index}`, DEFAULT_USER_ID, at(-1));
    }

    context.setNow(at(0));
    expect(await getDue()).toHaveLength(20);
  });

  it("returns an explicit empty list when nothing is due", async () => {
    await seedScheduled("future", DEFAULT_USER_ID, at(5));

    context.setNow(at(0));
    expect(await getDue()).toEqual([]);
  });
});

describe("POST /api/recall/prompts/:id/review", () => {
  it("applies FSRS, persists the advanced card, writes a review row, and returns the updated prompt", async () => {
    const promptId = await seedScheduled("quick", DEFAULT_USER_ID, at(-1));
    const expected = applyRating(newReviewState(at(-1)), "good", at(0));

    context.setNow(at(0));
    const response = await context.server.inject({
      method: "POST",
      payload: { rating: "good" },
      url: `/api/recall/prompts/${promptId}/review`
    });

    expect(response.statusCode).toBe(200);
    const updated = response.json() as MemoryPromptDto;
    expect(updated.review).toEqual(expected);
    expect(updated.review?.reps).toBe(1);

    const [row] = await context.db
      .select()
      .from(memoryPrompts)
      .where(eq(memoryPrompts.entryId, promptId));
    expect(row?.reps).toBe(1);
    expect(row?.dueAt?.toISOString()).toBe(expected.due);

    const reviews = await context.db
      .select()
      .from(memoryPromptReviews)
      .where(eq(memoryPromptReviews.promptEntryId, promptId));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.rating).toBe("good");

    // A reviewed prompt drops out of today's due batch.
    expect(await getDue()).toEqual([]);
  });

  it("rejects an invalid rating with 400", async () => {
    const promptId = await seedScheduled("quick", DEFAULT_USER_ID, at(-1));

    const response = await context.server.inject({
      method: "POST",
      payload: { rating: "perfect" },
      url: `/api/recall/prompts/${promptId}/review`
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 404 for a missing prompt", async () => {
    const response = await context.server.inject({
      method: "POST",
      payload: { rating: "good" },
      url: "/api/recall/prompts/nope/review"
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("POST /api/recall/prompts/:id/snooze", () => {
  it("defers the prompt out of today's batch by moving only its due date", async () => {
    const promptId = await seedScheduled("later", DEFAULT_USER_ID, at(-1));

    context.setNow(at(0));
    const response = await context.server.inject({
      method: "POST",
      url: `/api/recall/prompts/${promptId}/snooze`
    });

    expect(response.statusCode).toBe(200);
    const updated = response.json() as MemoryPromptDto;
    expect(updated.review).toEqual({ ...newReviewState(at(-1)), due: at(1).toISOString() });

    const reviews = await context.db
      .select()
      .from(memoryPromptReviews)
      .where(eq(memoryPromptReviews.promptEntryId, promptId));
    expect(reviews).toHaveLength(0);
    expect(await getDue()).toEqual([]);
  });

  it("returns 404 for a missing prompt", async () => {
    const response = await context.server.inject({
      method: "POST",
      url: "/api/recall/prompts/nope/snooze"
    });

    expect(response.statusCode).toBe(404);
  });
});

// Create a Memory over HTTP (owned by the injected DEFAULT_USER_ID) and return the deposit.
async function createNote(body: unknown): Promise<MemoryDepositDto> {
  const response = await context.server.inject({
    method: "POST",
    url: "/api/memory/notes",
    payload: body
  });
  expect(response.statusCode).toBe(201);
  return response.json() as MemoryDepositDto;
}

describe("POST /api/memory/notes", () => {
  it("creates a Memory and rejects an invalid body", async () => {
    const deposit = await createNote({
      captureSource: "manual",
      noteText: "遠慮 — to hold back",
      prompts: [{ cueText: "when holding back", answerText: "遠慮" }, { cueText: "answerless" }]
    });
    expect(deposit.prompts[0]?.lifecycle).toBe("scheduled");
    expect(deposit.prompts[1]?.lifecycle).toBe("draft");

    const invalid = await context.server.inject({
      method: "POST",
      url: "/api/memory/notes",
      payload: { captureSource: "manual", noteText: "", prompts: [] }
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe("POST /api/memory/import", () => {
  it("imports a batch of pasted drafts and rejects an invalid batch", async () => {
    const response = await context.server.inject({
      method: "POST",
      url: "/api/memory/import",
      payload: {
        items: [
          { captureSource: "import", noteText: "per", prompts: [{ cueText: "per" }] },
          {
            captureSource: "import",
            noteText: "push back",
            prompts: [{ cueText: "push back", answerText: "pushback" }]
          }
        ]
      }
    });
    expect(response.statusCode).toBe(201);
    const result = response.json() as ImportMemoryResultDto;
    expect(result.imported).toHaveLength(2);
    expect(result.imported[0]?.prompts[0]?.lifecycle).toBe("draft");
    expect(result.imported[1]?.prompts[0]?.lifecycle).toBe("scheduled");

    // The imported notes are owned by the injected user and appear through the standard notes list.
    const listResponse = await context.server.inject({ method: "GET", url: "/api/memory/notes" });
    expect((listResponse.json() as MemoryNoteListDto).items).toHaveLength(2);

    const invalid = await context.server.inject({
      method: "POST",
      url: "/api/memory/import",
      payload: { items: [] }
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe("GET /api/memory/notes", () => {
  it("lists the user's notes as summaries and searches by body or prompt text", async () => {
    const first = await createNote({
      captureSource: "manual",
      noteText: "photosynthesis note",
      prompts: [{ cueText: "a plant process", answerText: "growth" }]
    });
    await createNote({
      captureSource: "manual",
      noteText: "unrelated apples",
      prompts: [{ cueText: "fruit", answerText: "apple" }]
    });

    const listResponse = await context.server.inject({ method: "GET", url: "/api/memory/notes" });
    expect(listResponse.statusCode).toBe(200);
    expect((listResponse.json() as MemoryNoteListDto).items).toHaveLength(2);

    const searchResponse = await context.server.inject({
      method: "GET",
      url: "/api/memory/notes?q=photosynthesis"
    });
    const searched = (searchResponse.json() as MemoryNoteListDto).items;
    expect(searched).toHaveLength(1);
    expect(searched[0]?.noteId).toBe(first.note.noteId);
  });
});

describe("GET /api/memory/notes/:id", () => {
  it("returns a note's detail and 404 for a missing note", async () => {
    const deposit = await createNote({
      captureSource: "manual",
      noteText: "body",
      prompts: [{ cueText: "c", answerText: "a" }]
    });
    const response = await context.server.inject({
      method: "GET",
      url: `/api/memory/notes/${deposit.note.noteId}`
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as MemoryNoteDetailDto).prompts).toHaveLength(1);

    const missing = await context.server.inject({
      method: "GET",
      url: "/api/memory/notes/nope"
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("PATCH /api/memory/notes/:id", () => {
  it("edits a note body, rejects an invalid body, and 404s a missing note", async () => {
    const deposit = await createNote({
      captureSource: "manual",
      noteText: "old",
      prompts: [{ cueText: "c", answerText: "a" }]
    });
    const ok = await context.server.inject({
      method: "PATCH",
      url: `/api/memory/notes/${deposit.note.noteId}`,
      payload: { noteText: "new" }
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as MemoryNoteDetailDto).note.bodyText).toBe("new");

    const invalid = await context.server.inject({
      method: "PATCH",
      url: `/api/memory/notes/${deposit.note.noteId}`,
      payload: { noteText: "" }
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await context.server.inject({
      method: "PATCH",
      url: "/api/memory/notes/nope",
      payload: { noteText: "x" }
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("POST /api/memory/notes/:id/prompts", () => {
  it("adds a direction, rejects an invalid body, and 404s a missing note", async () => {
    const deposit = await createNote({
      captureSource: "manual",
      noteText: "body",
      prompts: [{ cueText: "c", answerText: "a" }]
    });
    const ok = await context.server.inject({
      method: "POST",
      url: `/api/memory/notes/${deposit.note.noteId}/prompts`,
      payload: { cueText: "second", answerText: "second answer" }
    });
    expect(ok.statusCode).toBe(201);
    expect((ok.json() as MemoryNoteDetailDto).prompts).toHaveLength(2);

    const invalid = await context.server.inject({
      method: "POST",
      url: `/api/memory/notes/${deposit.note.noteId}/prompts`,
      payload: { cueText: "" }
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await context.server.inject({
      method: "POST",
      url: "/api/memory/notes/nope/prompts",
      payload: { cueText: "c", answerText: "a" }
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("PATCH /api/memory/prompts/:id", () => {
  it("edits a prompt, rejects an invalid body, and 404s a missing prompt", async () => {
    const deposit = await createNote({
      captureSource: "manual",
      noteText: "body",
      prompts: [{ cueText: "cue", answerText: "answer" }]
    });
    const promptId = deposit.prompts[0]!.promptId;
    const ok = await context.server.inject({
      method: "PATCH",
      url: `/api/memory/prompts/${promptId}`,
      payload: { cueText: "reworded", answerText: "reworded answer" }
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as MemoryPromptDto).cueText).toBe("reworded");

    const invalid = await context.server.inject({
      method: "PATCH",
      url: `/api/memory/prompts/${promptId}`,
      payload: { cueText: "" }
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await context.server.inject({
      method: "PATCH",
      url: "/api/memory/prompts/nope",
      payload: { cueText: "c", answerText: "a" }
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("DELETE /api/memory/notes/:id", () => {
  it("deletes an owned note (204) and 404s a missing note", async () => {
    const deposit = await createNote({
      captureSource: "manual",
      noteText: "delete me",
      prompts: [{ cueText: "c", answerText: "a" }]
    });
    const ok = await context.server.inject({
      method: "DELETE",
      url: `/api/memory/notes/${deposit.note.noteId}`
    });
    expect(ok.statusCode).toBe(204);

    const gone = await context.server.inject({
      method: "GET",
      url: `/api/memory/notes/${deposit.note.noteId}`
    });
    expect(gone.statusCode).toBe(404);

    const missing = await context.server.inject({
      method: "DELETE",
      url: "/api/memory/notes/nope"
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("GET /api/memory/suggest", () => {
  it("returns a null suggestion when no glosser is wired and 400 for a blank term", async () => {
    const response = await context.server.inject({
      method: "GET",
      url: "/api/memory/suggest?term=%E9%81%A0%E6%85%AE"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ term: "遠慮", suggestion: null });

    const blank = await context.server.inject({
      method: "GET",
      url: "/api/memory/suggest?term=%20"
    });
    expect(blank.statusCode).toBe(400);

    const absent = await context.server.inject({ method: "GET", url: "/api/memory/suggest" });
    expect(absent.statusCode).toBe(400);
  });

  it("returns a suggestion from the offline glosser when wired", async () => {
    const pglite = new PGlite();
    await runMigrations(pglite);
    const db = createDbClient(pglite);
    const memory: MemoryRouteDependencies = {
      createId: () => "id",
      db,
      now: () => t0,
      resolveOfflineGloss: async (term) =>
        term === "遠慮" ? "to hold back out of consideration" : null
    };
    const server = createServer({ logger: false, recall: memory });
    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/memory/suggest?term=%E9%81%A0%E6%85%AE"
      });
      expect(response.json()).toEqual({
        term: "遠慮",
        suggestion: "to hold back out of consideration"
      });
    } finally {
      await db.$client.close();
    }
  });
});
