import type { SearchResultDto } from "@whetstone/contracts";
import { type DocumentNodeJSON, documentReadableText } from "@whetstone/document";
import { type MdastNodeLike, mdastReadableText } from "@whetstone/domain";
import { and, asc, eq, ilike, isNull, notExists, sql } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";

import type { DbClient } from "../../db/dbClient.js";
import { authors, blocks, docBlocks, readingUnits, workMeta } from "../../db/schema.js";

// Cap result rows: v0 search is a usable substring scan, not ranked relevance (PRODUCT.md
// "v0 search"), so a fixed ceiling keeps a broad term from shipping the whole library.
const searchResultLimit = 50;

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
// The MATCH runs on the stored, separator-free `plaintext` (the reader-aligned character stream,
// #344); the DISPLAYED snippet is a readable projection of the same block's stored node that inserts
// a boundary between block-level children, so a list's items read as `valley. Second` instead of
// running together as `valley.Second` (#503). The projection is display-only and never feeds
// matching or anchoring.
export async function searchBlocks(db: DbClient, query: string): Promise<SearchResultDto[]> {
  const pattern = `%${escapeLikePattern(query)}%`;

  // The PM substrate: `doc_blocks` carry the node + plaintext and are never soft-deleted, so a match
  // returns the node id the reader renders. Their unit join also yields the reading-order key.
  const docHalf = db
    .select({
      authorName: authors.name,
      blockEntryId: docBlocks.id,
      nodeJson: docBlocks.nodeJson,
      orderIndex: sql<number>`${docBlocks.orderIndex}`.as("block_order_index"),
      substrate: sql<string>`'pm'`.as("substrate"),
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
      nodeJson: blocks.mdastJson,
      orderIndex: sql<number>`${blocks.orderIndex}`.as("block_order_index"),
      substrate: sql<string>`'mdast'`.as("substrate"),
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
      nodeJson: hits.nodeJson,
      substrate: hits.substrate,
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
    plaintext: readableSnippet(row.substrate, row.nodeJson),
    workEntryId: row.workEntryId,
    workTitle: row.workTitle
  }));
}

// Project a hit's stored block node to its readable display text, picking the reader for the node's
// substrate: PM `doc_blocks` hold a ProseMirror node, legacy `blocks` hold an mdast node. Both
// readers insert a single space between block-level children so a list's items keep a boundary.
function readableSnippet(substrate: string, node: unknown): string {
  return substrate === "pm"
    ? documentReadableText(node as DocumentNodeJSON)
    : mdastReadableText(node as MdastNodeLike);
}
