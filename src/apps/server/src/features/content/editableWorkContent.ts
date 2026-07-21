import type { EntryId } from "@whetstone/domain";
import {
  assignNodeIds,
  createTextDocument,
  documentText,
  type DocumentNodeJSON
} from "@whetstone/document";
import { and, eq, inArray, or, sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import {
  chunks,
  docBlocks,
  entries,
  entryLinks,
  noteAnchors,
  readingPositions,
  readingUnits,
  recitationPassages,
  reviewCards,
  reviewEvents
} from "../../db/schema.js";

// The transaction the caller opened. Every operation writes through the caller's transaction so the
// origin-specific command owns atomicity, authorization, and lifecycle — this boundary only touches the
// shared rich-block storage (`reading_units`, `doc_blocks`, `entries`, `entry_links`) and never decides
// origin or ownership.
type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// The already-authorized Work context an initialization runs under. The caller has minted and inserted the
// Work Entry (and its origin/owner facets); this boundary only fills in the Work's content.
export type InitializeEditableWorkContentContext = Readonly<{
  createEntryId: () => string;
  workEntryId: EntryId;
}>;

export type InitializeEditableWorkContentResult = Readonly<{
  document: DocumentNodeJSON;
  unitEntryId: string;
}>;

// The already-authorized Work+unit context a reconciliation runs under. The caller has verified ownership
// and origin and looked up the Work's single reading unit; this boundary only reconciles that unit's blocks
// against `document`. Block ids come from the document nodes (id-stamped), so no id generator is needed.
export type ReconcileEditableWorkContentContext = Readonly<{
  document: DocumentNodeJSON;
  unitEntryId: string;
  workEntryId: EntryId;
}>;

export type ReconcileEditableWorkContentResult = Readonly<{
  document: DocumentNodeJSON;
}>;

type EditableBlock = Readonly<{
  id: string;
  node: DocumentNodeJSON;
  orderIndex: number;
  plaintext: string;
  type: string;
}>;

// Decompose an editor document into its top-level block rows, stamping stable ids first (idempotent, so
// unchanged nodes keep the id an existing `doc_blocks` row is keyed by and annotations stay anchored). The
// input is cloned before stamping so the caller's document object is never mutated. Each top-level node
// becomes one `doc_blocks` row; its plaintext is derived straight from the node.
function documentToBlocks(document: DocumentNodeJSON): Readonly<{
  blocks: ReadonlyArray<EditableBlock>;
  document: DocumentNodeJSON;
}> {
  const withIds = assignNodeIds(structuredClone(document));
  // Both callers pass a boundary-validated document (a `doc` always has content) and `assignNodeIds`
  // stamps every top-level node with a stable id, so content and each node id are present here — the
  // casts assert those invariants rather than adding an unreachable defensive fallback.
  const blocks = (withIds.content as ReadonlyArray<DocumentNodeJSON>).map((node, orderIndex) => ({
    id: (node.attrs as { id: string }).id,
    node,
    orderIndex,
    plaintext: documentText(node),
    type: node.type
  }));

  return { blocks, document: withIds };
}

// Initialize an editable Work's content: one reading unit and one empty, id-stamped ProseMirror paragraph,
// with the corresponding `entries` rows and `contains` links, written in the caller's transaction. Returns
// the new unit's Entry id and the stamped initial document so the command can build its response. The
// caller owns the Work Entry and its metadata/ownership facets; this boundary does not create or inspect
// them.
export async function initializeEditableWorkContent(
  tx: Transaction,
  context: InitializeEditableWorkContentContext
): Promise<InitializeEditableWorkContentResult> {
  const unitEntryId = context.createEntryId();
  const { blocks, document } = documentToBlocks(createTextDocument(""));

  await tx.insert(entries).values({ id: unitEntryId, type: "reading_unit" });
  await tx.insert(readingUnits).values({
    entryId: unitEntryId,
    orderIndex: 0,
    sourceFile: null,
    title: null,
    workEntryId: context.workEntryId
  });
  await tx
    .insert(entryLinks)
    .values({ fromEntryId: context.workEntryId, toEntryId: unitEntryId, type: "contains" });

  for (const block of blocks) {
    await insertBlock(tx, context.workEntryId, unitEntryId, block);
  }

  return { document, unitEntryId };
}

// Reconcile an editable Work's single reading unit to match `document`, preserving the id of every block
// that survives the edit so notes anchored to an unchanged block stay valid across saves. A set diff over
// block ids: surviving nodes are UPDATEd in place; genuinely new nodes are INSERTed (entries + doc_blocks +
// a `contains` edge); removed nodes have their `doc_blocks` row and containment edge deleted. A removed
// block's Entry is retained whenever durable history still references it (see `blockEntryStillReferenced`)
// — a note, a link, a reading position, a Recitation range endpoint, a review card, or a review event —
// so no learner-owned material or review schedule is destroyed as cleanup collateral; the anchor simply no
// longer resolves to rendered content. Only a genuinely unreferenced Entry is deleted, and its nullable
// provenance references (harvested chunks, `derived_from` links) are detached first so the delete is
// FK-safe. Runs entirely in the caller's transaction, so a save never lands half-applied. Returns the
// stamped document.
export async function reconcileEditableWorkContent(
  tx: Transaction,
  context: ReconcileEditableWorkContentContext
): Promise<ReconcileEditableWorkContentResult> {
  const { unitEntryId, workEntryId } = context;
  const { blocks, document: withIds } = documentToBlocks(context.document);
  const newIds = new Set(blocks.map((block) => block.id));

  const existingRows = await tx
    .select({ id: docBlocks.id })
    .from(docBlocks)
    .where(eq(docBlocks.readingUnitEntryId, unitEntryId));
  const existingIds = new Set(existingRows.map((row) => row.id));

  for (const block of blocks) {
    if (existingIds.has(block.id)) {
      await tx
        .update(docBlocks)
        .set({
          anchorId: null,
          anchors: [],
          nodeJson: block.node,
          orderIndex: block.orderIndex,
          plaintext: block.plaintext,
          type: block.type
        })
        .where(eq(docBlocks.id, block.id));
    } else {
      await insertBlock(tx, workEntryId, unitEntryId, block);
    }
  }

  const removedIds = [...existingIds].filter((id) => !newIds.has(id));
  if (removedIds.length > 0) {
    await tx.delete(docBlocks).where(inArray(docBlocks.id, removedIds));
    await tx
      .delete(entryLinks)
      .where(
        and(eq(entryLinks.fromEntryId, unitEntryId), inArray(entryLinks.toEntryId, removedIds))
      );

    const referencedIds = await stillReferencedBlockEntryIds(tx, removedIds);
    const deletableIds = removedIds.filter((id) => !referencedIds.has(id));

    if (deletableIds.length > 0) {
      // A removed block that nothing durable references is deleted, but its nullable provenance links are
      // detached first (they are nullable by design, mirroring the work-delete cascade): a Memory note
      // derived from the block keeps its owned content with the `derived_from` link dropped, and a chunk
      // harvested from the block keeps its row with `source_block_entry_id` nulled.
      await tx
        .delete(entryLinks)
        .where(
          or(
            inArray(entryLinks.fromEntryId, deletableIds),
            inArray(entryLinks.toEntryId, deletableIds)
          )
        );
      await tx
        .update(chunks)
        .set({ sourceBlockEntryId: null })
        .where(inArray(chunks.sourceBlockEntryId, deletableIds));
      await tx.delete(entries).where(inArray(entries.id, deletableIds));
    }
  }

  return { document: withIds };
}

async function insertBlock(
  tx: Transaction,
  workEntryId: EntryId,
  unitEntryId: string,
  block: EditableBlock
): Promise<void> {
  await tx.insert(entries).values({ id: block.id, type: "block" });
  await tx.insert(docBlocks).values({
    anchorId: null,
    anchors: [],
    id: block.id,
    nodeJson: block.node,
    orderIndex: block.orderIndex,
    plaintext: block.plaintext,
    readingUnitEntryId: unitEntryId,
    type: block.type,
    workEntryId
  });
  await tx
    .insert(entryLinks)
    .values({ fromEntryId: unitEntryId, toEntryId: block.id, type: "contains" });
}

// Which of `removedIds` are still referenced by durable history and so must be retained (their `entries`
// row kept, its `doc_blocks` content already gone). The arms mirror every FK that can point at a block
// Entry beyond its own containment and detachable provenance: a note anchor (start or end block), a
// Recitation passage range endpoint (start or end block), a saved reading position anchor, a review card
// or review-event target, and any durable `entry_links` relation (`annotates`/`references`/`related_to`)
// — deliberately NOT `contains` (rewritten by this reconcile) or `derived_from` (detachable provenance).
async function stillReferencedBlockEntryIds(
  tx: Transaction,
  removedIds: ReadonlyArray<string>
): Promise<ReadonlySet<string>> {
  const ids = [...removedIds];
  const referenced = new Set<string>();
  const collect = (rows: ReadonlyArray<Readonly<{ id: string }>>): void => {
    for (const row of rows) {
      referenced.add(row.id);
    }
  };

  collect(
    await tx
      .selectDistinct({ id: noteAnchors.blockEntryId })
      .from(noteAnchors)
      .where(inArray(noteAnchors.blockEntryId, ids))
  );
  collect(
    await tx
      .selectDistinct({ id: noteAnchors.endBlockEntryId })
      .from(noteAnchors)
      .where(inArray(noteAnchors.endBlockEntryId, ids))
  );
  collect(
    await tx
      .selectDistinct({ id: recitationPassages.startBlockEntryId })
      .from(recitationPassages)
      .where(inArray(recitationPassages.startBlockEntryId, ids))
  );
  collect(
    await tx
      .selectDistinct({ id: recitationPassages.endBlockEntryId })
      .from(recitationPassages)
      .where(inArray(recitationPassages.endBlockEntryId, ids))
  );
  collect(
    // `anchor_block_entry_id` is nullable, but `inArray` over the removed ids already excludes NULLs, so
    // the projection is asserted non-null — avoiding a per-row null guard that could never be exercised.
    await tx
      .selectDistinct({ id: sql<string>`${readingPositions.anchorBlockEntryId}` })
      .from(readingPositions)
      .where(inArray(readingPositions.anchorBlockEntryId, ids))
  );
  collect(
    await tx
      .selectDistinct({ id: reviewCards.targetEntryId })
      .from(reviewCards)
      .where(inArray(reviewCards.targetEntryId, ids))
  );
  collect(
    await tx
      .selectDistinct({ id: reviewEvents.targetEntryId })
      .from(reviewEvents)
      .where(inArray(reviewEvents.targetEntryId, ids))
  );
  collect(
    await tx
      .selectDistinct({ id: entryLinks.toEntryId })
      .from(entryLinks)
      .where(
        and(
          inArray(entryLinks.toEntryId, ids),
          inArray(entryLinks.type, ["annotates", "references", "related_to"])
        )
      )
  );

  return referenced;
}
