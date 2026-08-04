import { PGlite } from "@electric-sql/pglite";
import { toEntryId } from "@whetstone/domain";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  LatestReadingPositionResponse,
  ReadingPositionResponse,
  ReadingUnitContentDto,
  WorksWithReadingPositionResponse,
  WorkStructureDto
} from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { readingPositions } from "../../db/schema.js";
import { createSourceFileStore } from "../../files/sourceFileStore.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import type { ContentDependencies } from "../content/contentCommands.js";
import { createWork } from "../library/libraryCommands.js";
import type { LibraryRouteDependencies } from "../library/libraryRoutes.js";
import {
  getLatestReadingPosition,
  getReadingPosition,
  getWorksWithReadingPosition
} from "./readingPositionQueries.js";

// What a test may send as a request body -- including shapes the route must reject. `NonNullable`
// because `exactOptionalPropertyTypes` forbids handing `inject` an explicitly `undefined` payload.
type InjectPayload = NonNullable<InjectOptions["payload"]>;

type TestContext = Readonly<{
  db: DbClient;
  library: LibraryRouteDependencies;
  server: ReturnType<typeof createServer>;
  sourcesDir: string;
}>;

let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  const sourcesDir = await mkdtemp(join(tmpdir(), "whetstone-reading-position-"));

  let workSequence = 0;
  let contentSequence = 0;
  let sourceSequence = 0;
  const library: LibraryRouteDependencies = {
    createAuthorId: () => `author-${(workSequence += 1)}`,
    createEntryId: () => `work-${workSequence}`,
    db,
    // Work deletion is exercised in library.test.ts; these tests never call DELETE /api/works/:id,
    // so the file-side collaborators fail loudly rather than silently no-op.
    deleteSourceFile: () => Promise.reject(new Error("unexpected deleteSourceFile")),
    logSourceUnlinkFailure: () => {
      throw new Error("unexpected logSourceUnlinkFailure");
    },
    now: () => new Date()
  };
  const content: ContentDependencies = {
    createAuthorId: () => `content-author-${(contentSequence += 1)}`,
    createEntryId: () => `content-${(contentSequence += 1)}`,
    createSourceId: () => `source-${(sourceSequence += 1)}`,
    db,
    // These tests never ingest an EPUB; the parser, upload limit, and image store exist only to
    // satisfy the content route wiring, and fail loudly rather than silently no-op if reached.
    epubParser: () => Promise.reject(new Error("unexpected epubParser")),
    epubUploadLimitBytes: 50 * 1024 * 1024,
    imageResourceStore: {
      store: () => Promise.reject(new Error("unexpected imageResourceStore.store"))
    },
    ingestionLogger: () => {},
    sourceFileStore: createSourceFileStore(sourcesDir)
  };

  return {
    db,
    library,
    server: createServer({ content, library, logger: false, readingPosition: { db } }),
    sourcesDir
  };
}

async function createWorkWithUnitAndBlock(): Promise<{
  blockEntryId: string;
  unitEntryId: string;
  workEntryId: string;
}> {
  const created = await createWork(
    context.library,
    {
      author: { mode: "new", name: "Aesop" },
      language: "en",
      origin: "imported",
      title: "Fables",
      workType: "classical_text"
    },
    DEFAULT_USER_ID
  );
  if (created.status !== "created") {
    throw new Error("expected the imported seed Work to be created");
  }
  const workEntryId = created.work.work.entryId;

  await context.server.inject({
    method: "POST",
    payload: { kind: "manual", markdown: "The quick brown fox jumps over the lazy dog." },
    url: `/api/works/${workEntryId}/content`
  });

  const structureResponse = await context.server.inject({
    method: "GET",
    url: `/api/works/${workEntryId}/structure`
  });
  const structure = structureResponse.json() as WorkStructureDto;
  const unitMeta = structure.readingUnits[0];

  const unitResponse = await context.server.inject({
    method: "GET",
    url: `/api/works/${workEntryId}/units/${unitMeta?.entryId}/content`
  });
  const unit = unitResponse.json() as ReadingUnitContentDto;

  return {
    blockEntryId: unit.blocks[0]?.entryId as string,
    unitEntryId: unit.entryId,
    workEntryId
  };
}

function getPosition(workEntryId: string): Promise<LightMyRequestResponse> {
  return context.server.inject({
    method: "GET",
    url: `/api/works/${workEntryId}/reading-position`
  });
}

function putPosition(workEntryId: string, payload: InjectPayload): Promise<LightMyRequestResponse> {
  return context.server.inject({
    method: "PUT",
    payload,
    url: `/api/works/${workEntryId}/reading-position`
  });
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.server.close();
  await rm(context.sourcesDir, { force: true, recursive: true });
});

describe("reading-position routes", () => {
  it("round-trips a saved unit and block anchor", async () => {
    const { blockEntryId, unitEntryId, workEntryId } = await createWorkWithUnitAndBlock();

    const put = await putPosition(workEntryId, { anchorBlockEntryId: blockEntryId, unitEntryId });
    expect(put.statusCode).toBe(204);

    const get = await getPosition(workEntryId);
    expect(get.statusCode).toBe(200);
    expect((get.json() as ReadingPositionResponse).position).toEqual({
      anchorBlockEntryId: blockEntryId,
      unitEntryId
    });
  });

  it("stores a null anchor when none is supplied (top of the unit)", async () => {
    const { unitEntryId, workEntryId } = await createWorkWithUnitAndBlock();

    await putPosition(workEntryId, { unitEntryId });

    expect((await getPosition(workEntryId)).json()).toEqual({
      position: { anchorBlockEntryId: null, unitEntryId }
    });
  });

  it("replaces the position in place on a later save (one row per user + work)", async () => {
    const { blockEntryId, unitEntryId, workEntryId } = await createWorkWithUnitAndBlock();

    await putPosition(workEntryId, { anchorBlockEntryId: blockEntryId, unitEntryId });
    await putPosition(workEntryId, { unitEntryId });

    expect((await getPosition(workEntryId)).json()).toEqual({
      position: { anchorBlockEntryId: null, unitEntryId }
    });
  });

  it("returns a null position when nothing is saved", async () => {
    const { workEntryId } = await createWorkWithUnitAndBlock();

    expect((await getPosition(workEntryId)).json()).toEqual({ position: null });
  });

  it("rejects a malformed body with 400", async () => {
    const { workEntryId } = await createWorkWithUnitAndBlock();

    const response = await putPosition(workEntryId, { unitEntryId: "" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("scopes a saved position to the current user — another user sees none", async () => {
    const { unitEntryId, workEntryId } = await createWorkWithUnitAndBlock();
    await putPosition(workEntryId, { unitEntryId });
    const work = toEntryId(workEntryId);

    const owner = await getReadingPosition(context.db, work, DEFAULT_USER_ID);
    const other = await getReadingPosition(context.db, work, "another-user");

    expect(owner).toEqual({ anchorBlockEntryId: null, unitEntryId });
    expect(other).toBeUndefined();
  });

  it("does not leak one user's position to another over the route", async () => {
    const { unitEntryId, workEntryId } = await createWorkWithUnitAndBlock();
    await putPosition(workEntryId, { unitEntryId });

    const otherUserServer = createServer({
      currentUser: { getCurrentUserId: () => "other" },
      logger: false,
      readingPosition: { db: context.db }
    });

    try {
      const response = await otherUserServer.inject({
        method: "GET",
        url: `/api/works/${workEntryId}/reading-position`
      });

      expect(response.json()).toEqual({ position: null });
    } finally {
      await otherUserServer.close();
    }
  });
});

describe("latest reading position", () => {
  function seedPosition(
    workEntryId: string,
    unitEntryId: string,
    updatedAt: Date,
    userId = DEFAULT_USER_ID
  ): Promise<unknown> {
    return context.db.insert(readingPositions).values({
      anchorBlockEntryId: null,
      unitEntryId,
      updatedAt,
      userId,
      workEntryId
    });
  }

  it("returns the most-recently-updated position with its work title", async () => {
    const older = await createWorkWithUnitAndBlock();
    const newer = await createWorkWithUnitAndBlock();
    await seedPosition(older.workEntryId, older.unitEntryId, new Date("2026-01-01T00:00:00.000Z"));
    await seedPosition(newer.workEntryId, newer.unitEntryId, new Date("2026-02-01T00:00:00.000Z"));

    expect(await getLatestReadingPosition(context.db, DEFAULT_USER_ID)).toEqual({
      anchorBlockEntryId: null,
      unitEntryId: newer.unitEntryId,
      workEntryId: newer.workEntryId,
      workTitle: "Fables"
    });
  });

  it("returns undefined when the user has no saved position", async () => {
    await createWorkWithUnitAndBlock();

    expect(await getLatestReadingPosition(context.db, DEFAULT_USER_ID)).toBeUndefined();
  });

  it("scopes the latest position to the user — another user sees none", async () => {
    const { unitEntryId, workEntryId } = await createWorkWithUnitAndBlock();
    await seedPosition(workEntryId, unitEntryId, new Date("2026-01-01T00:00:00.000Z"));

    expect(await getLatestReadingPosition(context.db, "another-user")).toBeUndefined();
  });

  it("serves the latest position over the route", async () => {
    const { unitEntryId, workEntryId } = await createWorkWithUnitAndBlock();
    await seedPosition(workEntryId, unitEntryId, new Date("2026-01-01T00:00:00.000Z"));

    const response = await context.server.inject({
      method: "GET",
      url: "/api/reading-position/latest"
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as LatestReadingPositionResponse).position).toEqual({
      anchorBlockEntryId: null,
      unitEntryId,
      workEntryId,
      workTitle: "Fables"
    });
  });

  it("serves an explicit null over the route when nothing is saved", async () => {
    const response = await context.server.inject({
      method: "GET",
      url: "/api/reading-position/latest"
    });

    expect(response.json()).toEqual({ position: null });
  });

  it("bumps updated_at on a re-save so the latest reflects the last save", async () => {
    const first = await createWorkWithUnitAndBlock();
    const second = await createWorkWithUnitAndBlock();
    await seedPosition(first.workEntryId, first.unitEntryId, new Date("2026-01-01T00:00:00.000Z"));
    await seedPosition(
      second.workEntryId,
      second.unitEntryId,
      new Date("2026-02-01T00:00:00.000Z")
    );

    expect((await getLatestReadingPosition(context.db, DEFAULT_USER_ID))?.workEntryId).toBe(
      second.workEntryId
    );

    await putPosition(first.workEntryId, { unitEntryId: first.unitEntryId });

    expect((await getLatestReadingPosition(context.db, DEFAULT_USER_ID))?.workEntryId).toBe(
      first.workEntryId
    );
  });
});

describe("works with a saved reading position", () => {
  it("lists exactly the works the user has a position for (query)", async () => {
    const started = await createWorkWithUnitAndBlock();
    const untouched = await createWorkWithUnitAndBlock();
    await putPosition(started.workEntryId, { unitEntryId: started.unitEntryId });

    const ids = await getWorksWithReadingPosition(context.db, DEFAULT_USER_ID);

    expect(ids).toEqual([started.workEntryId]);
    expect(ids).not.toContain(untouched.workEntryId);
  });

  it("returns an empty list when the user has no saved positions (query)", async () => {
    await createWorkWithUnitAndBlock();

    expect(await getWorksWithReadingPosition(context.db, DEFAULT_USER_ID)).toEqual([]);
  });

  it("scopes the works to the user — another user sees none (query)", async () => {
    const { unitEntryId, workEntryId } = await createWorkWithUnitAndBlock();
    await putPosition(workEntryId, { unitEntryId });

    expect(await getWorksWithReadingPosition(context.db, "another-user")).toEqual([]);
  });

  it("serves the works with a saved position over the route", async () => {
    const started = await createWorkWithUnitAndBlock();
    await createWorkWithUnitAndBlock();
    await putPosition(started.workEntryId, { unitEntryId: started.unitEntryId });

    const response = await context.server.inject({
      method: "GET",
      url: "/api/reading-position/works"
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as WorksWithReadingPositionResponse).workEntryIds).toEqual([
      started.workEntryId
    ]);
  });

  it("does not leak one user's works to another over the route", async () => {
    const { unitEntryId, workEntryId } = await createWorkWithUnitAndBlock();
    await putPosition(workEntryId, { unitEntryId });

    const otherUserServer = createServer({
      currentUser: { getCurrentUserId: () => "other" },
      logger: false,
      readingPosition: { db: context.db }
    });

    try {
      const response = await otherUserServer.inject({
        method: "GET",
        url: "/api/reading-position/works"
      });

      expect((response.json() as WorksWithReadingPositionResponse).workEntryIds).toEqual([]);
    } finally {
      await otherUserServer.close();
    }
  });
});
