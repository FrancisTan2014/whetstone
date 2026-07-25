import {
  NEAR_MATCH_THRESHOLD,
  nearMatchLengthBand,
  projectNearMatch,
  selectNearMatches
} from "@whetstone/document";
import { toEntryId, type EntryId } from "@whetstone/domain";
import { and, asc, eq, gte, lte, ne } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { notes, personalEntries } from "../../db/schema.js";

// One near-match candidate for the target note: the owner's other note whose material is very similar prose,
// with its similarity score. The score is retained only for stable ordering and evidence — it is NEVER a
// confidence measure shown to a learner.
export type NearMatchNote = Readonly<{
  noteEntryId: EntryId;
  bodyText: string;
  score: number;
}>;

// The reader `findNearMatchNotes` needs: only the `select` query builder, which both the top-level `DbClient`
// and an open transaction satisfy, so a future command can reproject and recheck inside its own transaction.
export type NearMatchNoteReader = Pick<DbClient, "select">;

// Every body-bearing note the current owner already holds that is a high-precision NEAR match of the given
// document (#713) — at most five, ordered by score descending then note id. Strictly read-only: it writes
// nothing and proposes nothing; it only surfaces candidates for a later review step.
//
// The persisted `relaxed_key_length` index NARROWS the pool to the mathematically complete length band (any
// note that could clear the threshold must fall inside it — a shorter/longer note cannot); the guarded
// projection recomputed from each candidate body then decides. Ownership is scoped through the shared
// `personal_entries` facet, marks (bodyless) are excluded by `kind`, deleted notes are hard-deleted so
// absent, and the target note itself is excluded by id. An UNSUPPORTED target (a single word, non-ASCII, or
// structural body) projects to null and yields no candidates — near matching stays silent.
export async function findNearMatchNotes(
  db: NearMatchNoteReader,
  params: Readonly<{ bodyDoc: unknown; excludeNoteEntryId?: string; userId: string }>
): Promise<NearMatchNote[]> {
  const target = projectNearMatch(params.bodyDoc);
  if (target === null) {
    return [];
  }

  const band = nearMatchLengthBand(target.codePointLength, NEAR_MATCH_THRESHOLD);
  const ownership = [
    eq(notes.kind, "note"),
    eq(personalEntries.userId, params.userId),
    gte(notes.relaxedKeyLength, band.min),
    lte(notes.relaxedKeyLength, band.max)
  ];
  if (params.excludeNoteEntryId !== undefined) {
    ownership.push(ne(notes.entryId, params.excludeNoteEntryId));
  }

  const rows = await db
    .select({ bodyDoc: notes.bodyDoc, bodyText: notes.bodyText, entryId: notes.entryId })
    .from(notes)
    .innerJoin(personalEntries, eq(personalEntries.entryId, notes.entryId))
    .where(and(...ownership))
    .orderBy(asc(notes.entryId));

  const pool = rows.flatMap((row) => {
    const projection = projectNearMatch(row.bodyDoc);
    /* v8 ignore next 3 -- invariant: a row inside the length band carries a non-null relaxed key, so it was
       eligible when written and the same deterministic projection re-derives it; a null is unreachable. */
    if (projection === null) {
      return [];
    }
    return [{ note: { bodyText: row.bodyText as string, entryId: row.entryId }, projection }];
  });

  return selectNearMatches(target, pool, (note) => note.entryId).map((candidate) => ({
    bodyText: candidate.note.bodyText,
    noteEntryId: toEntryId(candidate.note.entryId),
    score: candidate.score
  }));
}
