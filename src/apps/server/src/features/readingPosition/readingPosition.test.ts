import { PGlite } from "@electric-sql/pglite";
import { toEntryId } from "@whetstone/domain";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ReadingPositionResponse, WorkContentDto } from "@whetstone/contracts";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { createSourceFileStore } from "../../files/sourceFileStore.js";
import { createServer } from "../../http/createServer.js";
import { DEFAULT_USER_ID } from "../../identity/currentUser.js";
import type { ContentDependencies } from "../content/contentCommands.js";
import type { LibraryDependencies } from "../library/libraryCommands.js";
import { getReadingPosition } from "./readingPositionQueries.js";

type TestContext = Readonly<{
  db: DbClient;
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
  const library: LibraryDependencies = {
    createAuthorId: () => `author-${(workSequence += 1)}`,
    createEntryId: () => `work-${workSequence}`,
    db
  };
  const content: ContentDependencies = {
    createEntryId: () => `content-${(contentSequence += 1)}`,
    createSourceId: () => `source-${(sourceSequence += 1)}`,
    db,
    sourceFileStore: createSourceFileStore(sourcesDir)
  };

  return {
    db,
    server: createServer({ content, library, logger: false, readingPosition: { db } }),
    sourcesDir
  };
}

async function createWorkWithUnitAndBlock(): Promise<{
  blockEntryId: string;
  unitEntryId: string;
  workEntryId: string;
}> {
  const workResponse = await context.server.inject({
    method: "POST",
    payload: {
      author: { mode: "new", name: "Aesop" },
      language: "en",
      title: "Fables",
      workType: "classical_text"
    },
    url: "/api/works"
  });
  const workEntryId = workResponse.json().work.entryId as string;

  await context.server.inject({
    method: "POST",
    payload: { kind: "manual", markdown: "The quick brown fox jumps over the lazy dog." },
    url: `/api/works/${workEntryId}/content`
  });

  const contentResponse = await context.server.inject({
    method: "GET",
    url: `/api/works/${workEntryId}/content`
  });
  const body = contentResponse.json() as WorkContentDto;
  const unit = body.readingUnits[0];

  return {
    blockEntryId: unit?.blocks[0]?.entryId as string,
    unitEntryId: unit?.entryId as string,
    workEntryId
  };
}

function getPosition(workEntryId: string): ReturnType<typeof context.server.inject> {
  return context.server.inject({
    method: "GET",
    url: `/api/works/${workEntryId}/reading-position`
  });
}

function putPosition(
  workEntryId: string,
  payload: unknown
): ReturnType<typeof context.server.inject> {
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
