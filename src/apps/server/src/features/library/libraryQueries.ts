import { toAuthorId, toEntryId } from "@whetstone/domain";
import type { AuthorSearchDto, WorkListDto, WorkListItemDto } from "@whetstone/contracts";
import { asc, eq, isNotNull, sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { authors, workMeta } from "../../db/schema.js";
import { correctableImportedWorkSql } from "./importedWorkContentQueries.js";

type AuthorRow = Readonly<{ id: string; name: string }>;

// The author create-or-select field's search boundary (#694). Owner-keyed "You" rows (NULL key) are
// always excluded — "You" groups authored writing and is not a reusable external author/source. A blank
// query returns the alphabetical list; a nonblank one returns canonical-key substring matches plus the
// exact-match id, all computed by the shared SQL identity functions so exact-match suppression stays
// authoritative on the server. `cleanedQuery` is the server-cleaned name the client offers as "Add".
export async function searchAuthors(db: DbClient, rawQuery?: string): Promise<AuthorSearchDto> {
  const query = rawQuery ?? "";
  const cleanedRow = await db.execute(sql`SELECT clean_author_name(${query}) AS cleaned`);
  const cleanedQuery = (cleanedRow.rows[0] as { cleaned: string }).cleaned;

  if (cleanedQuery === "") {
    const rows = await db
      .select({ id: authors.id, name: authors.name })
      .from(authors)
      .where(isNotNull(authors.nameKey))
      .orderBy(asc(authors.name));

    return {
      authors: rows.map((row) => ({ id: toAuthorId(row.id), name: row.name })),
      cleanedQuery: "",
      exactMatchId: null
    };
  }

  // `strpos` does a literal substring test over the canonical key, so query punctuation can never act as
  // a LIKE wildcard. Both sides use `author_name_key`, safe here because the cleaned query is nonblank.
  const matches = await db.execute(sql`
    SELECT id, name FROM authors
    WHERE name_key IS NOT NULL AND strpos(name_key, author_name_key(${query})) > 0
    ORDER BY name ASC
  `);
  const exact = await db.execute(sql`
    SELECT id FROM authors WHERE name_key = author_name_key(${query}) LIMIT 1
  `);
  const exactRow = exact.rows[0] as Pick<AuthorRow, "id"> | undefined;

  return {
    authors: (matches.rows as unknown as ReadonlyArray<AuthorRow>).map((row) => ({
      id: toAuthorId(row.id),
      name: row.name
    })),
    cleanedQuery,
    exactMatchId: exactRow === undefined ? null : toAuthorId(exactRow.id)
  };
}

export async function listWorks(db: DbClient): Promise<WorkListDto> {
  const rows = await db
    .select({
      authorId: authors.id,
      authorName: authors.name,
      correctable: correctableImportedWorkSql,
      entryId: workMeta.entryId,
      language: workMeta.language,
      origin: workMeta.origin,
      title: workMeta.title,
      workType: workMeta.workType
    })
    .from(workMeta)
    .innerJoin(authors, eq(workMeta.authorId, authors.id))
    .orderBy(asc(workMeta.title));

  const works: ReadonlyArray<WorkListItemDto> = rows.map((row) => ({
    author: { id: toAuthorId(row.authorId), name: row.authorName },
    correctable: row.correctable,
    work: {
      authorId: toAuthorId(row.authorId),
      entryId: toEntryId(row.entryId),
      language: row.language,
      origin: row.origin,
      title: row.title,
      workType: row.workType
    }
  }));

  return { works };
}
