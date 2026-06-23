import { toAuthorId, toEntryId } from "@whetstone/domain";
import type { AuthorListDto, WorkListDto, WorkListItemDto } from "@whetstone/contracts";
import { asc, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { authors, workMeta } from "../../db/schema.js";

export async function listAuthors(db: DbClient): Promise<AuthorListDto> {
  const rows = await db.select().from(authors).orderBy(asc(authors.name));

  return {
    authors: rows.map((row) => ({ id: toAuthorId(row.id), name: row.name }))
  };
}

export async function listWorks(db: DbClient): Promise<WorkListDto> {
  const rows = await db
    .select({
      authorId: authors.id,
      authorName: authors.name,
      entryId: workMeta.entryId,
      language: workMeta.language,
      title: workMeta.title,
      workType: workMeta.workType
    })
    .from(workMeta)
    .innerJoin(authors, eq(workMeta.authorId, authors.id))
    .orderBy(asc(workMeta.title));

  const works: ReadonlyArray<WorkListItemDto> = rows.map((row) => ({
    author: { id: toAuthorId(row.authorId), name: row.authorName },
    work: {
      authorId: toAuthorId(row.authorId),
      entryId: toEntryId(row.entryId),
      language: row.language,
      title: row.title,
      workType: row.workType
    }
  }));

  return { works };
}
