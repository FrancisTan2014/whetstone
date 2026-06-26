import type { SearchResultDto } from "@whetstone/contracts";
import { and, asc, eq, ilike, isNull } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { authors, blocks, readingUnits, workMeta } from "../../db/schema.js";

// Cap result rows: v0 search is a usable substring scan, not ranked relevance (PRODUCT.md
// "v0 search"), so a fixed ceiling keeps a broad term from shipping the whole library.
export const searchResultLimit = 50;

// Escape the LIKE wildcards (`%`, `_`) and the escape character (`\`) so a user's literal
// `%`/`_`/`\` matches literally instead of acting as a pattern. Postgres LIKE/ILIKE treats
// backslash as the default escape character.
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// Block-level search across the whole library: a case-insensitive substring match over each
// non-deleted block's plaintext, joined to its work and author so a hit can be shown and
// deep-linked. The inner join to reading units also drops soft-deleted/detached blocks (their
// reading-unit id is null), and `deleted_at IS NULL` excludes any still-attached soft-deleted row.
export async function searchBlocks(db: DbClient, query: string): Promise<SearchResultDto[]> {
  const pattern = `%${escapeLikePattern(query)}%`;

  const rows = await db
    .select({
      authorName: authors.name,
      blockEntryId: blocks.entryId,
      plaintext: blocks.plaintext,
      workEntryId: blocks.workEntryId,
      workTitle: workMeta.title
    })
    .from(blocks)
    .innerJoin(readingUnits, eq(blocks.readingUnitEntryId, readingUnits.entryId))
    .innerJoin(workMeta, eq(blocks.workEntryId, workMeta.entryId))
    .innerJoin(authors, eq(workMeta.authorId, authors.id))
    .where(and(isNull(blocks.deletedAt), ilike(blocks.plaintext, pattern)))
    .orderBy(asc(workMeta.title), asc(blocks.workEntryId), asc(blocks.orderIndex))
    .limit(searchResultLimit);

  return rows.map((row) => ({
    authorName: row.authorName,
    blockEntryId: row.blockEntryId,
    plaintext: row.plaintext,
    workEntryId: row.workEntryId,
    workTitle: row.workTitle
  }));
}
