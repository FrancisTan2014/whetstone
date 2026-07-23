import type { SearchResultDto } from "@whetstone/contracts";
import { buildSearchSnippet } from "@whetstone/domain";
import { and, asc, eq, ilike, isNull, notExists, sql } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";

import type { DbClient } from "../../db/dbClient.js";
import { authors, blocks, docBlocks, readingUnits, workMeta } from "../../db/schema.js";

// Cap result rows: v0 search is a usable substring scan, not ranked relevance (PRODUCT.md
// "v0 search"), so a fixed ceiling keeps a broad term from shipping the whole library.
const searchResultLimit = 50;

// Cap the hits any one Work contributes BEFORE the global limit, so a Work full of a repeated header
// or a very common term cannot starve every other Work out of the 50-row page (#726).
const perWorkHitCap = 5;

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
//
// Two boundedness/diversity guarantees (#726): each Work contributes at most `perWorkHitCap` hits
// (a database window over Work id and reading order, applied BEFORE the global `searchResultLimit`),
// and every retained hit ships a bounded snippet around its first match instead of the whole block.
// The match position that anchors the snippet is computed in SQL with the SAME case semantics the
// query matched with (`strpos(lower(plaintext), lower(query))`), so JavaScript never folds case to
// guess an offset. The snippet is a window into the stored, reader-aligned `plaintext` (#344), so its
// UTF-16 match range stays canonical for highlighting and future deep-linking.
export async function searchBlocks(db: DbClient, query: string): Promise<SearchResultDto[]> {
  const pattern = `%${escapeLikePattern(query)}%`;

  // The PM substrate: `doc_blocks` carry the plaintext and are never soft-deleted, so a match returns
  // the block id the reader renders. Their unit join also yields the reading-order key.
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

  // Rank each Work's hits by reading order so the per-Work cap keeps the FIRST few in reading order,
  // not an arbitrary set. The window partitions by Work and orders by reading unit then block.
  const ranked = db
    .select({
      authorName: hits.authorName,
      blockEntryId: hits.blockEntryId,
      orderIndex: hits.orderIndex,
      plaintext: hits.plaintext,
      unitOrderIndex: hits.unitOrderIndex,
      workEntryId: hits.workEntryId,
      workRank:
        sql<number>`row_number() over (partition by ${hits.workEntryId} order by ${hits.unitOrderIndex} asc, ${hits.orderIndex} asc)`.as(
          "work_rank"
        ),
      workTitle: hits.workTitle
    })
    .from(hits)
    .as("ranked");

  const rows = await db
    .select({
      authorName: ranked.authorName,
      blockEntryId: ranked.blockEntryId,
      // 1-based code-point index of the first match, or 0 when (impossibly) absent. Same case
      // semantics as the ILIKE match above, so the offset agrees with what matched.
      matchStart: sql<number>`strpos(lower(${ranked.plaintext}), lower(${query}))`.as("match_start"),
      plaintext: ranked.plaintext,
      unitOrderIndex: ranked.unitOrderIndex,
      orderIndex: ranked.orderIndex,
      workEntryId: ranked.workEntryId,
      workTitle: ranked.workTitle
    })
    .from(ranked)
    .where(sql`${ranked.workRank} <= ${perWorkHitCap}`)
    .orderBy(
      asc(ranked.workTitle),
      asc(ranked.workEntryId),
      asc(ranked.unitOrderIndex),
      asc(ranked.orderIndex)
    )
    .limit(searchResultLimit);

  // The matched region spans as many code points as the query: Postgres case folding (lower) is
  // length-preserving, so the case-insensitive match cannot be a different length than the query.
  const matchLengthCodePoints = Array.from(query).length;

  return rows.map((row) => ({
    authorName: row.authorName,
    blockEntryId: row.blockEntryId,
    snippet: buildSearchSnippet({
      matchLengthCodePoints,
      matchStartCodePoint: Math.max(0, row.matchStart - 1),
      plaintext: row.plaintext
    }),
    workEntryId: row.workEntryId,
    workTitle: row.workTitle
  }));
}
