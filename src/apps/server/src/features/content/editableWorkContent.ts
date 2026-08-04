import {
  diffBlockSequences,
  planSectionRepartition,
  planWorkContentReplacement,
  type BlockChangeSet,
  type BlockSequenceEntry,
  type EntryId,
  type RepartitionBlock,
  type RepartitionPlan
} from "@whetstone/domain";
import {
  assignNodeIds,
  createTextDocument,
  documentText,
  type DocumentNodeJSON
} from "@whetstone/document";
import { and, asc, count, eq, inArray, or, sql } from "drizzle-orm";

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
import { writeReadingUnits, type PersistableReadingUnit } from "./blockWriter.js";

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

// The already-authorized Work context an appended section runs under. The caller has verified ownership
// and origin and computed the next `orderIndex`; this boundary writes one more reading unit and its
// blocks from `document` (a manual Work's new section starts at a heading block — issue #697).
export type AppendEditableWorkSectionContext = Readonly<{
  createEntryId: () => string;
  document: DocumentNodeJSON;
  orderIndex: number;
  workEntryId: EntryId;
}>;

export type AppendEditableWorkSectionResult = Readonly<{
  document: DocumentNodeJSON;
  // Every block written for the new section (all genuinely new), so a correction caller can mark them.
  insertedBlockIds: readonly string[];
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

// The already-authorized Work+section context a repartition runs under (#698). The caller has verified
// ownership and origin and claimed the work's revision; this boundary substitutes the edited section's
// draft `document` into the Work's block stream and repartitions the affected span at heading boundaries.
// `editedUnitEntryId` names the section the learner saved; the returned `activeUnitEntryId` is the unit
// that now holds the first draft block (the same unit when its leading heading survived, the preceding
// unit when the section merged left), so the editor can stay on the section it was editing.
export type RepartitionEditableWorkContentContext = Readonly<{
  createEntryId: () => string;
  document: DocumentNodeJSON;
  editedUnitEntryId: string;
  workEntryId: EntryId;
}>;

export type RepartitionEditableWorkContentResult = Readonly<{
  activeUnitEntryId: string;
  // The precise before/after block change set over the affected span (#762): which current blocks were
  // inserted, had their content changed, were removed, or only reordered. A correction caller uses it to
  // stamp correction markers; the manual editor ignores it. An unchanged save reports an empty set.
  changeSet: BlockChangeSet;
}>;

type EditableBlock = Readonly<{
  id: string;
  node: DocumentNodeJSON;
  orderIndex: number;
  plaintext: string;
  type: string;
}>;

// The already-authorized Work context a whole-content replacement runs under (#861). The caller has
// verified the Work is eligible, claimed its `content_revision`, and produced the replacement units; this
// boundary swaps the Work's canonical content for them in the caller's transaction.
export type ReplaceWorkContentContext = Readonly<{
  createEntryId: () => string;
  // The replacement reading units in reading order. Non-empty: a caller with nothing to write refuses
  // rather than emptying the Work.
  units: readonly PersistableReadingUnit[];
  workEntryId: EntryId;
}>;

// What the Work held before the replacement and what it holds after, so an operator can see exactly what
// changed. Counted from the rows, not from the input, so the numbers are what actually landed.
export type ReplaceWorkContentResult = Readonly<{
  after: WorkContentCounts;
  before: WorkContentCounts;
}>;

export type WorkContentCounts = Readonly<{ blocks: number; units: number }>;

// A stable, order-independent serialization of a block's node used only to decide whether two blocks have
// identical content (#762). PostgreSQL `jsonb` does not preserve object key order, so a stored node read
// back and a freshly serialized draft node can differ byte-for-byte while being semantically identical;
// canonicalizing (recursively sorting object keys, preserving array order which is content-significant)
// makes the comparison faithful — a real content edit differs, a mere reorder or round-trip does not.
function canonicalContentKey(node: unknown): string {
  if (Array.isArray(node)) {
    return `[${node.map(canonicalContentKey).join(",")}]`;
  }
  if (node !== null && typeof node === "object") {
    const entries = Object.keys(node as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalContentKey((node as Record<string, unknown>)[key])}`
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(node);
}

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
  return writeEditableWorkSection(tx, {
    createEntryId: context.createEntryId,
    document: createTextDocument(""),
    orderIndex: 0,
    workEntryId: context.workEntryId
  });
}

// Append one more reading unit to an editable Work at `orderIndex`, seeded from `document` — the manual
// Work's "Add section" (#697) hands in a heading-led document so the new section is a real, navigable
// outline node from the first save. Same graph as an initialization (an `entries` row, a `reading_units`
// row, a `contains` link, one `doc_blocks` row per top-level node), written in the caller's transaction.
// The caller owns ownership/origin/concurrency; this boundary only writes the section's content.
export async function appendEditableWorkSection(
  tx: Transaction,
  context: AppendEditableWorkSectionContext
): Promise<AppendEditableWorkSectionResult> {
  return writeEditableWorkSection(tx, context);
}

// Insert one reading unit (its Entry, `reading_units` row, and `contains` link) plus its id-stamped
// blocks, at `orderIndex`. Shared by the initial section and every appended section so their graph is
// written identically.
async function writeEditableWorkSection(
  tx: Transaction,
  context: AppendEditableWorkSectionContext
): Promise<AppendEditableWorkSectionResult> {
  const unitEntryId = context.createEntryId();
  const { blocks, document } = documentToBlocks(context.document);

  await tx.insert(entries).values({ id: unitEntryId, type: "reading_unit" });
  await tx.insert(readingUnits).values({
    entryId: unitEntryId,
    orderIndex: context.orderIndex,
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

  return { document, insertedBlockIds: blocks.map((block) => block.id), unitEntryId };
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

// Repartition a manual Work's block stream after one section was saved (#698). ReadingUnits are bounded
// groupings projected from the ordered block stream; blocks are the durable identity. This substitutes the
// edited section's draft blocks into the Work's stream and repartitions the affected contiguous span at
// every heading node — the same boundary rule the Outline reads — preserving a unit's identity when its
// leading heading survives, minting a unit for each genuinely new heading, and merging a section whose
// leading heading was removed into the preceding unit. Every surviving block keeps its id (so notes,
// positions, and review history stay anchored), reading positions follow their anchor block (or land at
// the top of the surviving unit when the anchor was deleted), a removed block's Entry is retained whenever
// durable history still references it, and units emptied of identity are deleted. Only the affected span is
// touched; units before it are untouched and units after it are shifted by the net change in unit count.
// Pure containment arithmetic is delegated to the domain planner; this boundary reads the span, writes the
// plan, and remaps positions, all in the caller's transaction so a save never lands half-applied. Returns
// the unit that now holds the first draft block.
export async function repartitionEditableWorkContent(
  tx: Transaction,
  context: RepartitionEditableWorkContentContext
): Promise<RepartitionEditableWorkContentResult> {
  const { createEntryId, editedUnitEntryId, workEntryId } = context;
  const { blocks: draftBlocks } = documentToBlocks(context.document);
  // The caller normalizes the document to at least one block before repartitioning, so the draft stream is
  // never empty and its first block is a real node.
  const firstDraft = draftBlocks[0] as EditableBlock;

  const unitRows = await tx
    .select({ entryId: readingUnits.entryId, orderIndex: readingUnits.orderIndex })
    .from(readingUnits)
    .where(eq(readingUnits.workEntryId, workEntryId))
    .orderBy(asc(readingUnits.orderIndex));
  const editedIndex = unitRows.findIndex((unit) => unit.entryId === editedUnitEntryId);
  // The caller has verified the edited unit belongs to this Work, so it is always in the ordered set.
  const editedOrderIndex = (unitRows[editedIndex] as { orderIndex: number }).orderIndex;

  // Merge-left: a saved section whose first block is no longer a heading dissolves its own boundary and
  // joins the preceding unit, so the span starts one unit earlier and the two repartition together. The
  // leading section (index 0) has no predecessor, so its headless opening is the legitimate "Start" and it
  // repartitions alone.
  const mergeLeft = editedIndex > 0 && firstDraft.type !== "heading";
  const spanStart = mergeLeft ? editedIndex - 1 : editedIndex;
  const spanUnitRows = unitRows.slice(spanStart, editedIndex + 1);
  const spanUnitIds = spanUnitRows.map((unit) => unit.entryId);
  // The span's resulting units re-index densely from the first span unit's order, and the units after the
  // edited section shift by the net change so the whole Work's order indices stay a monotonic sequence
  // (robust to any pre-existing gaps — only relative order is read).
  const spanBaseOrderIndex = (spanUnitRows[0] as { orderIndex: number }).orderIndex;

  const existingBlockRows = await tx
    .select({
      id: docBlocks.id,
      nodeJson: docBlocks.nodeJson,
      orderIndex: docBlocks.orderIndex,
      readingUnitEntryId: docBlocks.readingUnitEntryId,
      type: docBlocks.type
    })
    .from(docBlocks)
    .where(inArray(docBlocks.readingUnitEntryId, spanUnitIds));
  const orderedIdsByUnit = new Map<string, string[]>();
  for (const unitId of spanUnitIds) {
    orderedIdsByUnit.set(unitId, []);
  }
  for (const row of [...existingBlockRows].sort((a, b) => a.orderIndex - b.orderIndex)) {
    (orderedIdsByUnit.get(row.readingUnitEntryId) as string[]).push(row.id);
  }
  // Each span block's content key BEFORE the edit, so the change set can tell a genuine content change from
  // a pure reorder (#762). Preceding-unit blocks (not in the draft) keep this key; draft blocks are keyed
  // from their new node below.
  const beforeContentById = new Map<string, string>(
    existingBlockRows.map((row) => [row.id, canonicalContentKey(row.nodeJson)])
  );

  // The affected stream after substitution: each preceding span unit contributes its blocks unchanged; the
  // edited unit contributes the draft blocks in their place (the edited unit is always the span's last).
  const draftBlockById = new Map(draftBlocks.map((block) => [block.id, block]));
  const streamBlocks: RepartitionBlock[] = [];
  for (const unitId of spanUnitIds) {
    if (unitId === editedUnitEntryId) {
      for (const block of draftBlocks) {
        streamBlocks.push({ id: block.id, isHeading: block.type === "heading" });
      }
    } else {
      for (const id of orderedIdsByUnit.get(unitId) as string[]) {
        streamBlocks.push({ id, isHeading: false });
      }
    }
  }

  const plan = planSectionRepartition({
    affectedUnits: spanUnitRows.map((unit) => ({
      blockIds: orderedIdsByUnit.get(unit.entryId) as string[],
      entryId: unit.entryId
    })),
    mintUnitId: createEntryId,
    streamBlocks
  });

  const existingSpanBlockIdSet = new Set<string>();
  for (const unitId of spanUnitIds) {
    for (const id of orderedIdsByUnit.get(unitId) as string[]) {
      existingSpanBlockIdSet.add(id);
    }
  }
  const finalBlockIds = new Set<string>();
  for (const unit of plan.units) {
    for (const id of unit.blockIds) {
      finalBlockIds.add(id);
    }
  }
  const removedBlockIds = [...existingSpanBlockIdSet].filter((id) => !finalBlockIds.has(id));

  // The precise change set over the span (#762). Before: the span's existing blocks in stream order.
  // After: the planned block stream, keyed by the draft node for an edited block and by the unchanged
  // before-key for a preceding block, so a content edit, insertion, removal, and reorder are told apart.
  const beforeStream: BlockSequenceEntry[] = [];
  for (const unitId of spanUnitIds) {
    for (const id of orderedIdsByUnit.get(unitId) as string[]) {
      beforeStream.push({ contentKey: beforeContentById.get(id) as string, id });
    }
  }
  const afterStream: BlockSequenceEntry[] = [];
  for (const unit of plan.units) {
    for (const id of unit.blockIds) {
      const draft = draftBlockById.get(id);
      afterStream.push({
        contentKey:
          draft === undefined
            ? (beforeContentById.get(id) as string)
            : canonicalContentKey(draft.node),
        id
      });
    }
  }
  const changeSet = diffBlockSequences(beforeStream, afterStream);

  // Insert each newly minted unit and re-index every resulting unit to its span position, so the affected
  // span occupies order indices `spanStart .. spanStart + units - 1` densely.
  await plan.units.reduce(async (previous, unit, offset) => {
    await previous;
    const orderIndex = spanBaseOrderIndex + offset;
    if (unit.isNew) {
      await tx.insert(entries).values({ id: unit.entryId, type: "reading_unit" });
      await tx.insert(readingUnits).values({
        entryId: unit.entryId,
        orderIndex,
        sourceFile: null,
        title: null,
        workEntryId
      });
      await tx
        .insert(entryLinks)
        .values({ fromEntryId: workEntryId, toEntryId: unit.entryId, type: "contains" });
    } else {
      await tx
        .update(readingUnits)
        .set({ orderIndex })
        .where(eq(readingUnits.entryId, unit.entryId));
    }
  }, Promise.resolve());

  // Rebuild containment for the span from scratch: drop the span units' block edges, then re-write every
  // block to its planned unit and order and re-add its edge. A surviving edited-section block is updated in
  // place (content refreshed, unit/order reassigned); a genuinely new block is inserted; a preceding block
  // (present in the stream but not in the draft) only changes unit/order, never content.
  await tx
    .delete(entryLinks)
    .where(and(inArray(entryLinks.fromEntryId, spanUnitIds), eq(entryLinks.type, "contains")));

  await plan.units.reduce(async (previous, unit) => {
    await previous;
    await unit.blockIds.reduce(async (inner, blockId, orderIndex) => {
      await inner;
      const draft = draftBlockById.get(blockId);
      if (draft === undefined) {
        await tx
          .update(docBlocks)
          .set({ orderIndex, readingUnitEntryId: unit.entryId })
          .where(eq(docBlocks.id, blockId));
      } else if (existingSpanBlockIdSet.has(blockId)) {
        await tx
          .update(docBlocks)
          .set({
            anchorId: null,
            anchors: [],
            nodeJson: draft.node,
            orderIndex,
            plaintext: draft.plaintext,
            readingUnitEntryId: unit.entryId,
            type: draft.type
          })
          .where(eq(docBlocks.id, blockId));
      } else {
        await tx.insert(entries).values({ id: blockId, type: "block" });
        await tx.insert(docBlocks).values({
          anchorId: null,
          anchors: [],
          id: blockId,
          nodeJson: draft.node,
          orderIndex,
          plaintext: draft.plaintext,
          readingUnitEntryId: unit.entryId,
          type: draft.type,
          workEntryId
        });
      }
      await tx
        .insert(entryLinks)
        .values({ fromEntryId: unit.entryId, toEntryId: blockId, type: "contains" });
    }, Promise.resolve());
  }, Promise.resolve());

  // Delete blocks the edit dropped, retaining any Entry durable history still references (its content row
  // is gone; the anchor simply no longer resolves) exactly as the single-unit reconcile does.
  if (removedBlockIds.length > 0) {
    await tx.delete(docBlocks).where(inArray(docBlocks.id, removedBlockIds));
    const referencedIds = await stillReferencedBlockEntryIds(tx, removedBlockIds);
    const deletableIds = removedBlockIds.filter((id) => !referencedIds.has(id));
    if (deletableIds.length > 0) {
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

  // Reading positions follow the content, then units emptied of identity are removed (positions first, so a
  // position never dangles off a to-be-deleted unit and the removal stays FK-safe).
  await remapReadingPositions(
    tx,
    workEntryId,
    plan,
    new Set(plan.removedUnitEntryIds),
    new Set(removedBlockIds)
  );

  if (plan.removedUnitEntryIds.length > 0) {
    await tx
      .delete(entryLinks)
      .where(
        and(
          eq(entryLinks.fromEntryId, workEntryId),
          inArray(entryLinks.toEntryId, plan.removedUnitEntryIds)
        )
      );
    await tx.delete(readingUnits).where(inArray(readingUnits.entryId, plan.removedUnitEntryIds));
    await tx.delete(entries).where(inArray(entries.id, plan.removedUnitEntryIds));
  }

  // Shift the units after the edited section by the net change in the span's unit count, keeping the whole
  // Work's order indices a dense, source-order sequence. Units before the span are untouched.
  const delta = spanBaseOrderIndex + plan.units.length - (editedOrderIndex + 1);
  if (delta !== 0) {
    await unitRows.slice(editedIndex + 1).reduce(async (previous, unit) => {
      await previous;
      await tx
        .update(readingUnits)
        .set({ orderIndex: unit.orderIndex + delta })
        .where(eq(readingUnits.entryId, unit.entryId));
    }, Promise.resolve());
  }

  return {
    activeUnitEntryId: plan.blockUnitEntryId.get(firstDraft.id) as string,
    changeSet
  };
}

// Replace a Work's WHOLE canonical content with freshly produced reading units (#861). Unlike the edit
// paths above — which preserve block identity because a human changed part of the text — this rebuilds the
// Work from a source projection: every replacement block carries a newly minted id, so no existing block
// survives and no unit identity is inherited. Used by the PDF re-map command, which re-runs the improved
// mapper over the retained converted payload; the caller owns authorization, the `content_revision` claim,
// and the transaction, and only ever calls this for a Work whose readable content is canonical
// `doc_blocks` (a legacy mdast `blocks` row pointing at a replaced unit would fail loudly on the delete
// rather than be silently orphaned).
//
// The order is what keeps it FK-safe: write the replacement first, move every saved reading position onto
// it, and only then delete what it replaced. A removed block's Entry is RETAINED whenever durable history
// still references it (a note, a link, a Recitation range endpoint, a review card or event), exactly as the
// edit paths do — a re-map improves rendering, it never destroys learner-owned material — so an anchor to
// replaced text survives as an Entry that no longer resolves to rendered content. Returns the before/after
// unit and block counts read from the rows themselves.
export async function replaceWorkContent(
  tx: Transaction,
  context: ReplaceWorkContentContext
): Promise<ReplaceWorkContentResult> {
  const { workEntryId } = context;

  const previousUnitRows = await tx
    .select({ entryId: readingUnits.entryId })
    .from(readingUnits)
    .where(eq(readingUnits.workEntryId, workEntryId))
    .orderBy(asc(readingUnits.orderIndex));
  const previousUnitEntryIds = previousUnitRows.map((row) => row.entryId);
  const previousBlockRows = await tx
    .select({ id: docBlocks.id })
    .from(docBlocks)
    .where(eq(docBlocks.workEntryId, workEntryId));
  const previousBlockIds = previousBlockRows.map((row) => row.id);

  // The shared block writer (#311) owns every insert, so the replacement's rows are written exactly like a
  // fresh ingestion's. Order indices restart at 0: the units they replace are deleted below, in this same
  // transaction, so the committed Work is a dense sequence.
  const written = await writeReadingUnits(tx, {
    createEntryId: context.createEntryId,
    startOrder: 0,
    units: context.units,
    workEntryId
  });

  // Reading positions move BEFORE the old units are deleted, so no position ever dangles off a removed
  // unit Entry. The pure planner decides where each one lands; this is the same remapper the section-edit
  // path uses, never a second implementation of that rule.
  const plan = planWorkContentReplacement({
    previousUnitEntryIds,
    replacementUnits: written.map((unit) => ({ blockIds: unit.docBlockIds, entryId: unit.entryId }))
  });
  await remapReadingPositions(
    tx,
    workEntryId,
    plan,
    new Set(previousUnitEntryIds),
    new Set(previousBlockIds)
  );

  if (previousBlockIds.length > 0) {
    // Dropping the `doc_blocks` rows also drops their additive per-block evidence (`pdf_block_evidence`
    // cascades on the block id), so stale geometry can never outlive the block it described.
    await tx.delete(docBlocks).where(inArray(docBlocks.id, previousBlockIds));
    const referencedIds = await stillReferencedBlockEntryIds(tx, previousBlockIds);
    const deletableIds = previousBlockIds.filter((id) => !referencedIds.has(id));
    if (deletableIds.length > 0) {
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

  if (previousUnitEntryIds.length > 0) {
    // A retained block Entry keeps its `contains` edge from its old unit, so those edges are cleared here
    // (not with the deletable blocks above) before the unit Entries they point out of are removed.
    await tx
      .delete(entryLinks)
      .where(
        and(inArray(entryLinks.fromEntryId, previousUnitEntryIds), eq(entryLinks.type, "contains"))
      );
    await tx
      .delete(entryLinks)
      .where(
        and(
          eq(entryLinks.fromEntryId, workEntryId),
          inArray(entryLinks.toEntryId, previousUnitEntryIds)
        )
      );
    await tx.delete(readingUnits).where(inArray(readingUnits.entryId, previousUnitEntryIds));
    await tx.delete(entries).where(inArray(entries.id, previousUnitEntryIds));
  }

  const afterRows = await tx
    .select({ value: count() })
    .from(docBlocks)
    .where(eq(docBlocks.workEntryId, workEntryId));

  return {
    after: {
      // The Work's own rows are the only truth about what landed, so a replacement that wrote fewer blocks
      // than it was handed cannot be reported as a clean success.
      blocks: afterRows.reduce((total, row) => total + row.value, 0),
      units: written.length
    },
    before: { blocks: previousBlockIds.length, units: previousUnitEntryIds.length }
  };
}

// Remap the Work's saved reading positions onto the repartitioned units (#698). A position anchored to a
// surviving block follows that block into whichever unit now holds it; a position whose anchor block was
// deleted drops the anchor and lands at the top of the unit that now holds its former neighbourhood; a
// top-of-unit position on a removed unit moves to that unit's surviving fallback. A position whose anchor
// is outside the affected span is left untouched. Runs before removed units are deleted so no position
// dangles.
async function remapReadingPositions(
  tx: Transaction,
  workEntryId: EntryId,
  plan: RepartitionPlan,
  removedUnitEntryIds: ReadonlySet<string>,
  removedBlockIds: ReadonlySet<string>
): Promise<void> {
  const rows = await tx
    .select({
      anchorBlockEntryId: readingPositions.anchorBlockEntryId,
      unitEntryId: readingPositions.unitEntryId,
      userId: readingPositions.userId
    })
    .from(readingPositions)
    .where(eq(readingPositions.workEntryId, workEntryId));

  await rows.reduce(async (previous, row) => {
    await previous;
    let nextUnit = row.unitEntryId;
    let nextAnchor = row.anchorBlockEntryId;

    if (row.anchorBlockEntryId === null) {
      if (removedUnitEntryIds.has(row.unitEntryId)) {
        nextUnit = plan.removedUnitFallback.get(row.unitEntryId) as string;
      }
    } else {
      const movedUnit = plan.blockUnitEntryId.get(row.anchorBlockEntryId);
      if (movedUnit !== undefined) {
        nextUnit = movedUnit;
      } else if (removedBlockIds.has(row.anchorBlockEntryId)) {
        nextAnchor = null;
        nextUnit = plan.removedUnitFallback.get(row.unitEntryId) ?? row.unitEntryId;
      }
    }

    if (nextUnit !== row.unitEntryId || nextAnchor !== row.anchorBlockEntryId) {
      await tx
        .update(readingPositions)
        .set({ anchorBlockEntryId: nextAnchor, unitEntryId: nextUnit })
        .where(
          and(
            eq(readingPositions.userId, row.userId),
            eq(readingPositions.workEntryId, workEntryId)
          )
        );
    }
  }, Promise.resolve());
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
