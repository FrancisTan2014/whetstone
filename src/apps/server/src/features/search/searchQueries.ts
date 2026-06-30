import type { SearchResultDto } from "@whetstone/contracts";
import { and, asc, eq, ilike, isNull, notExists, sql } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";

import type { DbClient } from "../../db/dbClient.js";
import { authors, blocks, docBlocks, readingUnits, workMeta } from "../../db/schema.js";

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
// matching block's plaintext, joined to its work and author so a hit can be shown and deep-linked.
// Each unit contributes hits from the SAME substrate the reader renders, so a result's
// `blockEntryId` equals the rendered `data-block-id`: the PM `doc_blocks` for a unit that has any
// (EPUB / PM-backed content), else the legacy mdast `blocks` (Markdown). A unit therefore appears in
// exactly one half — the legacy half excludes any block whose unit already has `doc_blocks` — so a
// PM-backed search hit deep-links to the block the reader actually stamps (#312). Results follow
// reading order within a work: by reading unit order, then block order inside the unit (an
// `order_index` is only meaningful within one unit, so it cannot order across units).
export async function searchBlocks(db: DbClient, query: string): Promise<SearchResultDto[]> {
  const pattern = `%${escapeLikePattern(query)}%`;

  // The PM substrate: `doc_blocks` carry plaintext and are never soft-deleted, so a match returns the
  // node id the reader renders. Their unit join also yields the reading-order key.
  const docHalf = db
    .select({
      authorName: authors.name,
      blockEntryId: docBlocks.id,
      orderIndex: sql<number>`${docBlocks.orderIndex}`.as("block_order_index"),
      plaintext: docBlocks.plaintext,
      unitOrderIndex: sql<number>`${readingUnits.orderIndex}`.as("unit_order_index"),
      workEntryId: docBlocks.workEntryId,
      workTitle: workMeta.title
    })
    .from(docBlocks)
    .innerJoin(readingUnits, eq(docBlocks.readingUnitEntryId, readingUnits.entryId))
    .innerJoin(workMeta, eq(docBlocks.workEntryId, workMeta.entryId))
    .innerJoin(authors, eq(workMeta.authorId, authors.id))
    .where(ilike(docBlocks.plaintext, pattern));

  // The legacy substrate: only for units the reader still renders from mdast — those with NO
  // `doc_blocks`. The inner join to reading units drops detached blocks (null unit id) and
  // `deleted_at IS NULL` excludes still-attached soft-deleted rows.
  const legacyHalf = db
    .select({
      authorName: authors.name,
      blockEntryId: blocks.entryId,
      orderIndex: sql<number>`${blocks.orderIndex}`.as("block_order_index"),
      plaintext: blocks.plaintext,
      unitOrderIndex: sql<number>`${readingUnits.orderIndex}`.as("unit_order_index"),
      workEntryId: blocks.workEntryId,
      workTitle: workMeta.title
    })
    .from(blocks)
    .innerJoin(readingUnits, eq(blocks.readingUnitEntryId, readingUnits.entryId))
    .innerJoin(workMeta, eq(blocks.workEntryId, workMeta.entryId))
    .innerJoin(authors, eq(workMeta.authorId, authors.id))
    .where(
      and(
        isNull(blocks.deletedAt),
        ilike(blocks.plaintext, pattern),
        notExists(
          db
            .select({ present: docBlocks.id })
            .from(docBlocks)
            .where(eq(docBlocks.readingUnitEntryId, blocks.readingUnitEntryId))
        )
      )
    );

  const hits = union(docHalf, legacyHalf).as("search_hits");

  const rows = await db
    .select({
      authorName: hits.authorName,
      blockEntryId: hits.blockEntryId,
      plaintext: hits.plaintext,
      workEntryId: hits.workEntryId,
      workTitle: hits.workTitle
    })
    .from(hits)
    .orderBy(
      asc(hits.workTitle),
      asc(hits.workEntryId),
      asc(hits.unitOrderIndex),
      asc(hits.orderIndex)
    )
    .limit(searchResultLimit);

  return rows.map((row) => ({
    authorName: row.authorName,
    blockEntryId: row.blockEntryId,
    plaintext: row.plaintext,
    workEntryId: row.workEntryId,
    workTitle: row.workTitle
  }));
}
