import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { toAuthorId, toEntryId } from "@whetstone/domain";
import type { WorkLanguage, WorkType } from "@whetstone/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { authors as authorsTable, entries, workMeta } from "../../db/schema.js";
import {
  findWorkDuplicateCandidates,
  type ProposedWorkMetadataInput,
  type WorkDuplicateCandidateLog
} from "./workDuplicateCandidatesQueries.js";

// #724 server boundary: real migrations (so the shared `work_title_key` function and the `title_key`
// column exist), then seed Works directly and score proposed metadata. Every seeded key is computed by the
// SAME SQL function the query uses, so the test never re-implements normalization.

const AUTHOR_MAIN = "author-main";
const AUTHOR_OTHER = "author-other";

type LogCall = Readonly<{ payload: Record<string, unknown>; message: string }>;

async function buildDb(): Promise<DbClient> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);

  await db.insert(authorsTable).values([
    { id: AUTHOR_MAIN, name: "Main Author", nameKey: "mainauthor" },
    { id: AUTHOR_OTHER, name: "Other Author", nameKey: "otherauthor" }
  ]);

  return db;
}

async function seedWork(
  db: DbClient,
  input: Readonly<{
    entryId: string;
    title: string;
    authorId?: string;
    language?: WorkLanguage;
    workType?: WorkType;
    origin?: "imported" | "manual" | "authored";
  }>
): Promise<void> {
  await db.insert(entries).values({ id: input.entryId, type: "work" });
  // `title_key` is a generated column: PostgreSQL derives it from the title via `work_title_key`, so writers
  // (production and tests alike) never supply it.
  await db.insert(workMeta).values({
    authorId: input.authorId ?? AUTHOR_MAIN,
    entryId: input.entryId,
    language: input.language ?? "en",
    title: input.title,
    workType: input.workType ?? "book",
    origin: input.origin ?? "imported"
  });
}

function proposal(overrides: Partial<ProposedWorkMetadataInput> = {}): ProposedWorkMetadataInput {
  return {
    title: "Clean Code",
    authorId: toAuthorId(AUTHOR_MAIN),
    language: "en",
    workType: "book",
    ...overrides
  };
}

function recordingLog(): { calls: LogCall[]; log: WorkDuplicateCandidateLog } {
  const calls: LogCall[] = [];
  return {
    calls,
    log: { info: (payload, message) => calls.push({ payload, message }) }
  };
}

async function countRows(db: DbClient): Promise<Readonly<{ entries: number; works: number }>> {
  const entryRow = await db.execute(sql`SELECT count(*)::int AS c FROM entries`);
  const workRow = await db.execute(sql`SELECT count(*)::int AS c FROM work_meta`);
  return {
    entries: (entryRow.rows[0] as { c: number }).c,
    works: (workRow.rows[0] as { c: number }).c
  };
}

let db: DbClient;

beforeEach(async () => {
  db = await buildDb();
});

describe("findWorkDuplicateCandidates", () => {
  it("keys the proposed title with the shared SQL function and finds an exact match across authors", async () => {
    await seedWork(db, { entryId: "w-same", title: "Clean Code", authorId: AUTHOR_MAIN });
    await seedWork(db, { entryId: "w-diff", title: "clean  code", authorId: AUTHOR_OTHER });

    const { calls, log } = recordingLog();
    // A whitespace/case variant of the proposed title still keys identically, proving SQL normalization.
    const result = await findWorkDuplicateCandidates(db, log, proposal({ title: "  CLEAN code " }));

    expect(result.totalCandidateCount).toBe(2);
    expect(result.candidates.map((row) => row.entryId)).toEqual(["w-diff", "w-same"]);
    expect(result.candidates.every((row) => row.matchTier === "exact")).toBe(true);
    const sameAuthor = new Map(
      result.candidates.map((row) => [row.entryId, row.evidence.sameAuthor])
    );
    expect(sameAuthor.get(toEntryId("w-same"))).toBe(true);
    expect(sameAuthor.get(toEntryId("w-diff"))).toBe(false);
    expect(calls).toEqual([
      {
        payload: { totalCandidateCount: 2, returnedCandidateCount: 2 },
        message: "work_duplicate_candidates_evaluated"
      }
    ]);
  });

  it("treats a brand-new author (null id) proposal as never same-author (exact match stays cross-author)", async () => {
    await seedWork(db, { entryId: "w-exact", title: "Clean Code", authorId: AUTHOR_MAIN });

    const { log } = recordingLog();
    const result = await findWorkDuplicateCandidates(db, log, proposal({ authorId: null }));

    expect(result.candidates.map((row) => row.entryId)).toEqual(["w-exact"]);
    expect(result.candidates[0]?.matchTier).toBe("exact");
    expect(result.candidates[0]?.evidence.sameAuthor).toBe(false);
  });

  it("excludes authored Works — the learner's own Writing is never an import/manual duplicate (owner isolation)", async () => {
    await seedWork(db, { entryId: "w-authored", title: "Clean Code", origin: "authored" });
    await seedWork(db, { entryId: "w-imported", title: "Clean Code", origin: "imported" });
    await seedWork(db, { entryId: "w-manual", title: "Clean Code", origin: "manual" });

    const { log } = recordingLog();
    const result = await findWorkDuplicateCandidates(db, log, proposal());

    expect(result.candidates.map((row) => row.entryId).sort()).toEqual(["w-imported", "w-manual"]);
    expect(result.candidates.some((row) => row.entryId === "w-authored")).toBe(false);
  });

  it("is source-agnostic: distinct Works sharing a title key are all surfaced, never deduped by source", async () => {
    // Source isolation: retrieval is driven purely by metadata (title key + author + origin) and never by
    // the #706 sha256 uploaded-source mechanism, so two separately imported copies both appear.
    await seedWork(db, { entryId: "w-copy-1", title: "Clean Code", origin: "imported" });
    await seedWork(db, { entryId: "w-copy-2", title: "Clean Code", origin: "manual" });

    const { log } = recordingLog();
    const result = await findWorkDuplicateCandidates(db, log, proposal());

    expect(result.totalCandidateCount).toBe(2);
    expect(result.candidates.map((row) => row.entryId).sort()).toEqual(["w-copy-1", "w-copy-2"]);
  });

  it("retrieves a complete bounded pool: a near typo inside the length window still qualifies", async () => {
    // Transposition (distance 1) → similarity 1 - 1/9 ≈ 0.889 ≥ 0.87 for the same author.
    await seedWork(db, { entryId: "w-typo", title: "Clena Code", authorId: AUTHOR_MAIN });

    const { log } = recordingLog();
    const result = await findWorkDuplicateCandidates(db, log, proposal());

    expect(result.candidates.map((row) => row.entryId)).toEqual(["w-typo"]);
    expect(result.candidates[0]?.matchTier).toBe("same_author_fuzzy");
    expect(result.candidates[0]?.evidence.titleSimilarity).toBeGreaterThanOrEqual(0.87);
  });

  it("distinguishes C++ Primer from C Primer rather than reporting a duplicate", async () => {
    // "c++primer" vs "cprimer": two deletions, similarity 1 - 2/9 ≈ 0.778 < 0.87 — clearly distinct.
    await seedWork(db, { entryId: "w-c", title: "C Primer", authorId: AUTHOR_MAIN });

    const { log } = recordingLog();
    const result = await findWorkDuplicateCandidates(db, log, proposal({ title: "C++ Primer" }));

    expect(result.candidates).toEqual([]);
    expect(result.totalCandidateCount).toBe(0);
  });

  it("does not confuse clearly distinct titles", async () => {
    await seedWork(db, {
      entryId: "w-unrelated",
      title: "The Pragmatic Programmer",
      authorId: AUTHOR_MAIN
    });

    const { log } = recordingLog();
    const result = await findWorkDuplicateCandidates(db, log, proposal());

    expect(result.candidates).toEqual([]);
  });

  it("surfaces language and work-type differences as factual evidence for an exact title-key match", async () => {
    await seedWork(db, {
      entryId: "w-variant",
      title: "Clean Code",
      authorId: AUTHOR_MAIN,
      language: "zh-CN",
      workType: "essay"
    });

    const { log } = recordingLog();
    const result = await findWorkDuplicateCandidates(db, log, proposal());

    expect(result.candidates[0]?.matchTier).toBe("exact");
    expect(result.candidates[0]?.evidence.languageDiffers).toBe(true);
    expect(result.candidates[0]?.evidence.workTypeDiffers).toBe(true);
  });

  it("reports edition-marker differences without claiming a duplicate", async () => {
    const base = "The Cambridge Companion to Modern English Poetry and Prose";
    await seedWork(db, { entryId: "w-revised", title: `${base} Revised`, authorId: AUTHOR_MAIN });

    const { log } = recordingLog();
    const result = await findWorkDuplicateCandidates(db, log, proposal({ title: base }));

    expect(result.candidates.map((row) => row.entryId)).toEqual(["w-revised"]);
    expect(result.candidates[0]?.evidence.editionMarkerDifferences).toEqual(["revised"]);
  });

  it("applies the stricter cross-author threshold: a same-author near match is not credible across authors", async () => {
    // "clenacode" (transposition, distance 1) → similarity ≈ 0.889: clears 0.87 (same author) but not 0.94.
    await seedWork(db, { entryId: "w-cross", title: "Clena Code", authorId: AUTHOR_OTHER });

    const { log } = recordingLog();
    const result = await findWorkDuplicateCandidates(db, log, proposal());

    expect(result.candidates).toEqual([]);
  });

  it("ranks exact over same-author fuzzy over cross-author fuzzy, then by score and Work id", async () => {
    await seedWork(db, { entryId: "w-exact", title: "Clean Code", authorId: AUTHOR_MAIN });
    await seedWork(db, { entryId: "w-fuzzy-same", title: "Clena Code", authorId: AUTHOR_MAIN });
    // A different-author copy of the exact title is still an exact tier (title-key match, any author).
    await seedWork(db, { entryId: "w-exact-other", title: "Clean Code", authorId: AUTHOR_OTHER });

    const { log } = recordingLog();
    const result = await findWorkDuplicateCandidates(db, log, proposal());

    expect(result.candidates.map((row) => row.entryId)).toEqual([
      "w-exact",
      "w-exact-other",
      "w-fuzzy-same"
    ]);
    expect(result.candidates.map((row) => row.matchTier)).toEqual([
      "exact",
      "exact",
      "same_author_fuzzy"
    ]);
  });

  it("returns at most five candidates with stable Work-id ordering while reporting the full total", async () => {
    for (let index = 0; index < 8; index += 1) {
      await seedWork(db, { entryId: `w-${index}`, title: "Clean Code", authorId: AUTHOR_MAIN });
    }

    const { calls, log } = recordingLog();
    const result = await findWorkDuplicateCandidates(db, log, proposal());

    expect(result.totalCandidateCount).toBe(8);
    expect(result.candidates).toHaveLength(5);
    expect(result.candidates.map((row) => row.entryId)).toEqual([
      "w-0",
      "w-1",
      "w-2",
      "w-3",
      "w-4"
    ]);
    expect(calls[0]?.payload).toEqual({ totalCandidateCount: 8, returnedCandidateCount: 5 });
  });

  it("writes nothing: the row counts are unchanged after scoring", async () => {
    await seedWork(db, { entryId: "w-a", title: "Clean Code", authorId: AUTHOR_MAIN });
    await seedWork(db, { entryId: "w-b", title: "Clena Code", authorId: AUTHOR_MAIN });

    const before = await countRows(db);
    await findWorkDuplicateCandidates(db, recordingLog().log, proposal());
    const after = await countRows(db);

    expect(after).toEqual(before);
  });
});
