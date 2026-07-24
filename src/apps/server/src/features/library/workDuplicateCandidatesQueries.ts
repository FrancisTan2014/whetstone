import {
  candidateTitleKeyLengthBounds,
  selectWorkDuplicateCandidates,
  toAuthorId,
  toEntryId
} from "@whetstone/domain";
import type {
  AuthorId,
  ExistingWorkCandidate,
  WorkDuplicateCandidateResult,
  WorkLanguage,
  WorkType
} from "@whetstone/domain";
import { and, eq, ne, sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { authors, workMeta } from "../../db/schema.js";

// #724 server-owned Work duplicate-candidate boundary. It computes the proposed title's canonical key with
// the SAME database function that keyed every stored Work (`work_title_key`), never re-implementing Unicode
// lowercase in JavaScript; retrieves a bounded, mathematically complete pool by title-key LENGTH; excludes
// authored Works (the learner's own Writing is never an import/manual duplicate); scores the pool with the
// pure domain function; logs the total credible-candidate count; and returns the review set. It writes
// nothing and never labels a row a duplicate.

// The proposed metadata under review — the display title (keyed here in SQL), the chosen/created author,
// and the language/type used for factual difference evidence. `authorId` is `null` when the learner typed
// a brand-new author name matching no existing Library identity (#747): the author row is created only
// inside the final Work transaction, so no author exists yet to corroborate — such a proposal can never be
// same-author and only the stricter cross-author title bar applies.
export type ProposedWorkMetadataInput = Readonly<{
  title: string;
  authorId: AuthorId | null;
  language: WorkLanguage;
  workType: WorkType;
}>;

// A minimal structural logger (pino/Fastify's `request.log` satisfies it) so the boundary can record how
// many credible candidates existed without depending on Fastify.
export type WorkDuplicateCandidateLog = Readonly<{
  info: (payload: Record<string, unknown>, message: string) => void;
}>;

export async function findWorkDuplicateCandidates(
  db: DbClient,
  log: WorkDuplicateCandidateLog,
  proposed: ProposedWorkMetadataInput
): Promise<WorkDuplicateCandidateResult> {
  // Key the proposed title with the shared SQL function, so migration, every writer, and this reader agree
  // on one normalization policy. `work_title_key` fails loud on a blank-after-normalization title.
  const keyRow = await db.execute(sql`SELECT work_title_key(${proposed.title}) AS key`);
  const proposedTitleKey = (keyRow.rows[0] as { key: string }).key;

  // Length is measured in CODE POINTS to match PostgreSQL `char_length` on the same keys, so the bounded
  // window stays a provably complete superset of every possible fuzzy match.
  const proposedKeyLength = Array.from(proposedTitleKey).length;
  const { minLength, maxLength } = candidateTitleKeyLengthBounds(proposedKeyLength);

  const rows = await db
    .select({
      entryId: workMeta.entryId,
      title: workMeta.title,
      titleKey: workMeta.titleKey,
      authorId: authors.id,
      authorName: authors.name,
      language: workMeta.language,
      workType: workMeta.workType
    })
    .from(workMeta)
    .innerJoin(authors, eq(workMeta.authorId, authors.id))
    .where(
      and(
        // Authored Works are the learner's own Writing, never an imported/manual-source duplicate.
        ne(workMeta.origin, "authored"),
        sql`char_length(${workMeta.titleKey}) between ${minLength} and ${maxLength}`
      )
    );

  const pool: ReadonlyArray<ExistingWorkCandidate> = rows.map((row) => ({
    entryId: toEntryId(row.entryId),
    title: row.title,
    titleKey: row.titleKey,
    authorId: toAuthorId(row.authorId),
    authorName: row.authorName,
    language: row.language,
    workType: row.workType
  }));

  const result = selectWorkDuplicateCandidates(
    {
      titleKey: proposedTitleKey,
      authorId: proposed.authorId,
      language: proposed.language,
      workType: proposed.workType
    },
    pool
  );

  log.info(
    {
      totalCandidateCount: result.totalCandidateCount,
      returnedCandidateCount: result.candidates.length
    },
    "work_duplicate_candidates_evaluated"
  );

  return result;
}
