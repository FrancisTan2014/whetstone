import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ImportMemoryResultDto, MemoryDepositDto, NoteReviewDto } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import { createStandaloneNote, type NotesDependencies } from "../notes/noteCommands.js";
import { depositMemory } from "./memoryCommands.js";
import type { MemoryRouteDependencies } from "./memoryRoutes.js";

const otherUser = "user-other";
const t0 = new Date("2026-01-01T00:00:00.000Z");

type TestContext = Readonly<{
  db: DbClient;
  memory: MemoryRouteDependencies;
  notes: NotesDependencies;
  server: ReturnType<typeof createServer>;
}>;

let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);

  let sequence = 0;
  const memory: MemoryRouteDependencies = {
    createId: () => `id-${(sequence += 1)}`,
    db,
    now: () => t0
  };
  let noteSequence = 0;
  const notes: NotesDependencies = {
    createEntryId: () => `note-${(noteSequence += 1)}`,
    db,
    now: () => t0
  };

  return { db, memory, notes, server: createServer({ logger: false, notes, recall: memory }) };
}

// Create an empty manual note (via the standalone command) owned by the given user.
async function seedNote(userId: string): Promise<string> {
  const note = await createStandaloneNote(
    context.notes,
    { bodyDoc: { type: "doc", content: [] } },
    userId
  );
  return note.entryId;
}

// Import one ready-but-cardless prompt for the current user; returns its prompt id.
async function importReadyPrompt(): Promise<string> {
  const response = await context.server.inject({
    method: "POST",
    url: "/api/memory/import",
    payload: {
      items: [
        {
          captureSource: "import",
          noteText: "spill the beans",
          prompts: [{ cueText: "spill the beans", answerText: "to reveal a secret" }]
        }
      ]
    }
  });
  const body = response.json() as { imported: ImportMemoryResultDto };
  return body.imported[0]!.prompts[0]!.promptId;
}

// Deposit one enrolled (carded) prompt for the current user; returns its prompt id.
async function seedEnrolledPrompt(userId: string = DEFAULT_USER_ID): Promise<string> {
  const deposit: MemoryDepositDto = await depositMemory(
    context.memory,
    {
      captureSource: "practice",
      noteText: "spill the beans",
      prompts: [{ cueText: "spill the beans", answerText: "to reveal a secret" }]
    },
    userId,
    t0
  );
  return deposit.prompts[0]!.promptId;
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.db.$client.close();
});

describe("GET /api/memory/notes/:id/review", () => {
  it("returns the note's review settings for an owned note", async () => {
    const noteId = await seedNote(DEFAULT_USER_ID);

    const response = await context.server.inject({
      method: "GET",
      url: `/api/memory/notes/${noteId}/review`
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as NoteReviewDto).noteId).toBe(noteId);
  });

  it("404s another user's note", async () => {
    const noteId = await seedNote(otherUser);

    const response = await context.server.inject({
      method: "GET",
      url: `/api/memory/notes/${noteId}/review`
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("POST /api/memory/notes/:id/review", () => {
  it("enrolls a note and returns its review", async () => {
    const noteId = await seedNote(DEFAULT_USER_ID);

    const response = await context.server.inject({
      method: "POST",
      url: `/api/memory/notes/${noteId}/review`,
      payload: { cueText: "spill the beans", answerText: "to reveal a secret" }
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as NoteReviewDto).prompts).toHaveLength(1);
  });

  it("400s an invalid body", async () => {
    const noteId = await seedNote(DEFAULT_USER_ID);

    const response = await context.server.inject({
      method: "POST",
      url: `/api/memory/notes/${noteId}/review`,
      payload: { cueText: "spill the beans" }
    });

    expect(response.statusCode).toBe(400);
  });

  it("404s another user's note", async () => {
    const noteId = await seedNote(otherUser);

    const response = await context.server.inject({
      method: "POST",
      url: `/api/memory/notes/${noteId}/review`,
      payload: { cueText: "spill the beans", answerText: "to reveal a secret" }
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("POST /api/memory/prompts/:id/enroll", () => {
  it("enrolls a cardless imported prompt", async () => {
    const promptId = await importReadyPrompt();

    const response = await context.server.inject({
      method: "POST",
      url: `/api/memory/prompts/${promptId}/enroll`
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { cardStatus: string }).cardStatus).toBe("active");
  });

  it("404s a missing prompt", async () => {
    const response = await context.server.inject({
      method: "POST",
      url: "/api/memory/prompts/missing/enroll"
    });

    expect(response.statusCode).toBe(404);
  });

  it("409s an already-enrolled prompt", async () => {
    const promptId = await seedEnrolledPrompt();

    const response = await context.server.inject({
      method: "POST",
      url: `/api/memory/prompts/${promptId}/enroll`
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toBe("already_enrolled");
  });
});

describe("POST /api/memory/prompts/:id/{pause,resume,restart}", () => {
  it("pauses an enrolled prompt", async () => {
    const promptId = await seedEnrolledPrompt();

    const response = await context.server.inject({
      method: "POST",
      url: `/api/memory/prompts/${promptId}/pause`
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { cardStatus: string }).cardStatus).toBe("paused");
  });

  it("resumes a paused prompt", async () => {
    const promptId = await seedEnrolledPrompt();
    await context.server.inject({ method: "POST", url: `/api/memory/prompts/${promptId}/pause` });

    const response = await context.server.inject({
      method: "POST",
      url: `/api/memory/prompts/${promptId}/resume`
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { cardStatus: string }).cardStatus).toBe("active");
  });

  it("restarts an enrolled prompt", async () => {
    const promptId = await seedEnrolledPrompt();

    const response = await context.server.inject({
      method: "POST",
      url: `/api/memory/prompts/${promptId}/restart`
    });

    expect(response.statusCode).toBe(200);
  });

  it("409s a cardless prompt (nothing to schedule)", async () => {
    const promptId = await importReadyPrompt();

    const response = await context.server.inject({
      method: "POST",
      url: `/api/memory/prompts/${promptId}/pause`
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toBe("not_scheduled");
  });

  it("404s a missing prompt", async () => {
    const response = await context.server.inject({
      method: "POST",
      url: "/api/memory/prompts/missing/pause"
    });

    expect(response.statusCode).toBe(404);
  });
});
