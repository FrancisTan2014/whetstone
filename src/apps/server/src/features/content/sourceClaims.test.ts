import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { toAuthorId, toEntryId, type EntryId } from "@whetstone/domain";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { authors, entries, uploadedSourceClaims, workMeta } from "../../db/schema.js";
import {
  claimUploadedSource,
  findClaimedWork,
  insertSourceClaim,
  isUniqueViolation
} from "./sourceClaims.js";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

let pglite: PGlite;
let db: DbClient;
let authorSequence: number;

async function seedAuthor(): Promise<string> {
  const id = `author-${(authorSequence += 1)}`;
  await db.insert(authors).values({ id, name: id, nameKey: id });

  return id;
}

// Insert a full Work (entry + work_meta) inside `writer` so `findClaimedWork`'s join resolves it. The
// caller supplies whether this runs in a transaction or against the base db.
async function writeWork(
  writer: Pick<DbClient, "insert">,
  entryId: EntryId,
  authorId: string
): Promise<void> {
  await writer.insert(entries).values({ id: entryId, type: "work" });
  await writer.insert(workMeta).values({
    authorId,
    entryId,
    language: "en",
    origin: "imported",
    title: `Work ${entryId}`,
    workType: "book"
  });
}

beforeEach(async () => {
  pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
  authorSequence = 0;
});

afterEach(async () => {
  await pglite.close();
});

describe("isUniqueViolation", () => {
  it("recognizes a PostgreSQL 23505 error", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("finds the code on a wrapped cause chain", () => {
    expect(isUniqueViolation({ cause: { code: "23505" }, message: "Failed query" })).toBe(true);
  });

  it("rejects a non-unique error, a codeless error, a wrapped non-unique cause, null, and a primitive", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation({ cause: { code: "23503" } })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("nope")).toBe(false);
  });
});

describe("findClaimedWork", () => {
  it("returns undefined for an unclaimed hash", async () => {
    expect(await findClaimedWork(db, "sha-none")).toBeUndefined();
  });

  it("returns the Work and content a claim resolves to", async () => {
    const authorId = await seedAuthor();
    const workEntryId = toEntryId("work-1");
    await writeWork(db, workEntryId, authorId);
    await db.insert(uploadedSourceClaims).values({ sha256: "sha-1", workEntryId });

    const claimed = await findClaimedWork(db, "sha-1");
    expect(claimed?.work).toMatchObject({
      entryId: workEntryId,
      origin: "imported",
      title: "Work work-1"
    });
    expect(claimed?.content.readingUnits).toEqual([]);
  });
});

describe("insertSourceClaim", () => {
  it("writes one claim row keyed by the hash", async () => {
    const authorId = await seedAuthor();
    const workEntryId = toEntryId("work-1");
    await writeWork(db, workEntryId, authorId);
    await db.transaction(async (tx: Tx) => insertSourceClaim(tx, "sha-1", workEntryId));

    const rows = await db
      .select()
      .from(uploadedSourceClaims)
      .where(eq(uploadedSourceClaims.sha256, "sha-1"));
    expect(rows).toEqual([{ sha256: "sha-1", workEntryId }]);
  });
});

describe("claimUploadedSource", () => {
  it("creates a new Work, its claim, and returns created", async () => {
    const authorId = await seedAuthor();
    const stage = vi.fn(async () => ({ path: "source-1.md" }));
    const releaseStage = vi.fn(async () => {});

    const outcome = await claimUploadedSource(db, {
      sha256: "sha-new",
      stage,
      releaseStage,
      commit: async (tx, staged) => {
        expect(staged.path).toBe("source-1.md");
        const workEntryId = toEntryId("work-1");
        await writeWork(tx, workEntryId, authorId);

        return {
          expectedBlockCount: 0,
          work: {
            authorId: toAuthorId(authorId),
            entryId: workEntryId,
            language: "en",
            origin: "imported",
            title: "Work work-1",
            workType: "book"
          },
          workEntryId
        };
      }
    });

    expect(outcome.status).toBe("created");
    expect(outcome.work.entryId).toBe("work-1");
    expect(releaseStage).not.toHaveBeenCalled();
    expect(await findClaimedWork(db, "sha-new")).toBeDefined();
  });

  it("reopens the existing Work without staging when the hash is already claimed", async () => {
    const authorId = await seedAuthor();
    const workEntryId = toEntryId("work-1");
    await writeWork(db, workEntryId, authorId);
    await db.insert(uploadedSourceClaims).values({ sha256: "sha-1", workEntryId });

    const stage = vi.fn(async () => ({ path: "unused.md" }));
    const releaseStage = vi.fn(async () => {});

    const outcome = await claimUploadedSource(db, {
      sha256: "sha-1",
      stage,
      releaseStage,
      commit: async () => {
        throw new Error("commit must not run for an already-claimed hash");
      }
    });

    expect(outcome.status).toBe("exact_existing");
    expect(outcome.work.entryId).toBe("work-1");
    expect(stage).not.toHaveBeenCalled();
    expect(releaseStage).not.toHaveBeenCalled();
  });

  it("releases the stage and reopens the concurrent winner on a unique violation", async () => {
    const winnerAuthorId = await seedAuthor();
    const loserAuthorId = await seedAuthor();
    const releaseStage = vi.fn(async () => {});

    const outcome = await claimUploadedSource(db, {
      sha256: "sha-race",
      // A concurrent winner commits its Work + claim for the same hash after our initial miss but
      // before our own insert — modelled by committing it here in the pre-transaction stage step.
      stage: async () => {
        const winnerEntryId = toEntryId("winner");
        await writeWork(db, winnerEntryId, winnerAuthorId);
        await db
          .insert(uploadedSourceClaims)
          .values({ sha256: "sha-race", workEntryId: winnerEntryId });

        return { path: "loser.md" };
      },
      releaseStage,
      commit: async (tx) => {
        const loserEntryId = toEntryId("loser");
        await writeWork(tx, loserEntryId, loserAuthorId);

        return {
          expectedBlockCount: 0,
          work: {
            authorId: toAuthorId(loserAuthorId),
            entryId: loserEntryId,
            language: "en",
            origin: "imported",
            title: "Work loser",
            workType: "book"
          },
          workEntryId: loserEntryId
        };
      }
    });

    expect(outcome.status).toBe("exact_existing");
    expect(outcome.work.entryId).toBe("winner");
    expect(releaseStage).toHaveBeenCalledOnce();
    // The loser's Work was rolled back with its transaction — only the winner remains.
    const workRows = await db.select().from(workMeta);
    expect(workRows.map((row) => row.entryId)).toEqual(["winner"]);
  });

  it("releases the stage and rethrows a non-unique commit error", async () => {
    const authorId = await seedAuthor();
    const releaseStage = vi.fn(async () => {});
    const failure = new Error("commit blew up");

    await expect(
      claimUploadedSource(db, {
        sha256: "sha-fail",
        stage: async () => ({ path: "staged.md" }),
        releaseStage,
        commit: async (tx) => {
          await writeWork(tx, toEntryId("work-1"), authorId);
          throw failure;
        }
      })
    ).rejects.toBe(failure);

    expect(releaseStage).toHaveBeenCalledOnce();
    expect(await db.select().from(uploadedSourceClaims)).toEqual([]);
  });

  it("rethrows a unique violation when the winner cannot be resolved", async () => {
    const authorId = await seedAuthor();
    const releaseStage = vi.fn(async () => {});

    // A dangling claim (its Work has no work_meta row) is committed for the hash before our insert, so
    // both finds miss the join yet our insert still collides — the boundary must surface the error.
    await expect(
      claimUploadedSource(db, {
        sha256: "sha-dangling",
        stage: async () => {
          await db.insert(entries).values({ id: "ghost", type: "work" });
          await db
            .insert(uploadedSourceClaims)
            .values({ sha256: "sha-dangling", workEntryId: toEntryId("ghost") });

          return { path: "loser.md" };
        },
        releaseStage,
        commit: async (tx) => {
          const workEntryId = toEntryId("work-1");
          await writeWork(tx, workEntryId, authorId);

          return {
            expectedBlockCount: 0,
            work: {
              authorId: toAuthorId(authorId),
              entryId: workEntryId,
              language: "en",
              origin: "imported",
              title: "Work work-1",
              workType: "book"
            },
            workEntryId
          };
        }
      })
    ).rejects.toSatisfy(isUniqueViolation);

    expect(releaseStage).toHaveBeenCalledOnce();
  });
});
