import { sql } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";

import type { DbClient } from "./dbClient.js";
import { blocks, docBlocks } from "./schema.js";

// A unified read over every addressable block in the library — both the legacy mdast `blocks`
// (search / Markdown) and the PM `doc_blocks` the reader renders (#312) — so any note / reading
// position / locate id resolves regardless of which substrate produced it. Both halves expose the
// same shape: the block's entry id, owning unit, order, plaintext, work, and soft-delete state.
// `doc_blocks` are never soft-deleted, so their `deletedAt` is always null; callers that must exclude
// soft-deleted content add their own `IS NULL` filter, while note-listing keeps detached blocks by
// omitting it. Returned aliased and rebuilt per call so it can be a `from`/join target in one query.
export function addressableBlocks(db: DbClient) {
  return union(
    db
      .select({
        deletedAt: blocks.deletedAt,
        entryId: blocks.entryId,
        orderIndex: blocks.orderIndex,
        plaintext: blocks.plaintext,
        readingUnitEntryId: blocks.readingUnitEntryId,
        workEntryId: blocks.workEntryId
      })
      .from(blocks),
    db
      .select({
        deletedAt: sql<Date | null>`null`.as("deleted_at"),
        entryId: docBlocks.id,
        orderIndex: docBlocks.orderIndex,
        plaintext: docBlocks.plaintext,
        readingUnitEntryId: docBlocks.readingUnitEntryId,
        workEntryId: docBlocks.workEntryId
      })
      .from(docBlocks)
  ).as("addressable_blocks");
}
