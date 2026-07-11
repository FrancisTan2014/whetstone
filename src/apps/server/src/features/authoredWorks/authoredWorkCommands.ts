import { toEntryId, type EntryId } from "@whetstone/domain";
import type { AuthoredWorkDto, CreateAuthoredWorkRequest } from "@whetstone/contracts";
import {
  assignNodeIds,
  createTextDocument,
  documentText,
  type DocumentNodeJSON
} from "@whetstone/document";
import { and, eq, inArray, or } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import {
  authors,
  chunks,
  docBlocks,
  entries,
  entryLinks,
  noteAnchors,
  personalEntries,
  readingUnits,
  workMeta
} from "../../db/schema.js";

// Real infrastructure boundaries (db, id generation, the clock) are injected so the authored-work
// commands stay deterministic and testable. Authoring a Work reuses the ingested-content substrate: an
// owned Work is stored as the same `entries`/`work_meta`/`reading_units`/`doc_blocks` rows an imported
// Work is, plus a `personal_entries` facet that marks it owned and orders it on the learner's Timeline.
export type AuthoredWorkDependencies = Readonly<{
  createEntryId: () => string;
  db: DbClient;
  now: () => Date;
}>;

export type UpdateAuthoredWorkContentResult =
  | Readonly<{ status: "updated"; work: AuthoredWorkDto }>
  | Readonly<{ status: "not_found" }>;

// The learner authors under a single per-user "self" author so their Works group together in the Library
// without a real author record. The id is derived from the user id (not a random UUID) so it is a stable
// get-or-create key: the first authored Work inserts the row, every later one reuses it.
const SELF_AUTHOR_NAME = "You";

function selfAuthorIdFor(userId: string): string {
  return `self-author:${userId}`;
}

type AuthoredBlock = Readonly<{
  id: string;
  node: DocumentNodeJSON;
  orderIndex: number;
  plaintext: string;
  type: string;
}>;

// Decompose an editor document into its top-level block rows, stamping stable ids first (idempotent, so
// unchanged nodes keep the id an existing `doc_blocks` row is keyed by and annotations stay anchored).
// Each top-level node becomes one `doc_blocks` row; its plaintext is derived straight from the node.
function documentToBlocks(document: DocumentNodeJSON): Readonly<{
  blocks: ReadonlyArray<AuthoredBlock>;
  document: DocumentNodeJSON;
}> {
  const withIds = assignNodeIds(document);
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

// Create an owned Work and open it empty: one transaction writes the get-or-create self author, the
// `entries(work)` + `work_meta` metadata, the `personal_entries` ownership+chronology facet (occurred =
// created = updated = now, server-owned so the client cannot backdate it), a single `reading_units` row,
// and one initial empty paragraph `doc_blocks` block — so the editor loads a valid, note-addressable
// document from the first save. The returned document is the stamped initial document.
export async function createAuthoredWork(
  dependencies: AuthoredWorkDependencies,
  request: CreateAuthoredWorkRequest,
  userId: string
): Promise<AuthoredWorkDto> {
  const now = dependencies.now();
  const workEntryId = dependencies.createEntryId();
  const unitEntryId = dependencies.createEntryId();
  const selfAuthorId = selfAuthorIdFor(userId);
  const { blocks, document } = documentToBlocks(createTextDocument(""));

  await dependencies.db.transaction(async (tx) => {
    const [author] = await tx
      .select({ id: authors.id })
      .from(authors)
      .where(eq(authors.id, selfAuthorId))
      .limit(1);
    if (author === undefined) {
      await tx.insert(authors).values({ id: selfAuthorId, name: SELF_AUTHOR_NAME });
    }

    await tx.insert(entries).values({ id: workEntryId, type: "work" });
    await tx.insert(workMeta).values({
      authorId: selfAuthorId,
      entryId: workEntryId,
      language: request.language,
      title: request.title,
      workType: request.workType
    });
    await tx
      .insert(personalEntries)
      .values({ createdAt: now, entryId: workEntryId, occurredAt: now, updatedAt: now, userId });
    await tx.insert(entries).values({ id: unitEntryId, type: "reading_unit" });
    await tx
      .insert(readingUnits)
      .values({ entryId: unitEntryId, orderIndex: 0, sourceFile: null, title: null, workEntryId });
    await tx
      .insert(entryLinks)
      .values({ fromEntryId: workEntryId, toEntryId: unitEntryId, type: "contains" });

    for (const block of blocks) {
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
  });

  const iso = now.toISOString();
  return {
    createdAt: iso,
    document,
    entryId: toEntryId(workEntryId),
    language: request.language,
    title: request.title,
    unitEntryId,
    updatedAt: iso,
    workType: request.workType
  };
}

// Save an authored Work's canonical document (latest-write-safe): replace its `doc_blocks` while
// preserving the id of every block that survives the edit, so notes anchored to an unchanged block stay
// valid across saves. Scoped to the owner via `personal_entries`: a forged id, another user's Work, or an
// imported (non-owned) Work is rejected (404). The whole reconcile runs in one transaction so a save
// never lands half-applied.
//
// Reconcile is a set diff over block ids: nodes still present are UPDATEd in place (content/order/type,
// anchors reset — authored blocks carry no source-HTML anchors); genuinely new nodes are INSERTed
// (entries + doc_blocks + a `contains` edge); removed nodes have their `doc_blocks` row and containment
// edge deleted. A removed block's `entries` row is deleted too UNLESS a note still anchors it — then the
// row is kept so the note's FK stays valid and the note survives (its anchor simply no longer resolves to
// rendered content). Before deleting a block Entry, any recall item / harvested chunk that referenced it
// is detached (provenance is nullable by design), mirroring the work-delete cascade.
export async function updateAuthoredWorkContent(
  dependencies: AuthoredWorkDependencies,
  workEntryId: EntryId,
  document: DocumentNodeJSON,
  userId: string
): Promise<UpdateAuthoredWorkContentResult> {
  const now = dependencies.now();

  return dependencies.db.transaction(async (tx) => {
    const [owned] = await tx
      .select({
        createdAt: personalEntries.createdAt,
        language: workMeta.language,
        title: workMeta.title,
        unitEntryId: readingUnits.entryId,
        workType: workMeta.workType
      })
      .from(workMeta)
      .innerJoin(personalEntries, eq(personalEntries.entryId, workMeta.entryId))
      .innerJoin(readingUnits, eq(readingUnits.workEntryId, workMeta.entryId))
      .where(and(eq(workMeta.entryId, workEntryId), eq(personalEntries.userId, userId)))
      .limit(1);

    if (owned === undefined) {
      return { status: "not_found" };
    }

    const unitEntryId = owned.unitEntryId;

    const { blocks, document: withIds } = documentToBlocks(document);
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
    }

    const removedIds = [...existingIds].filter((id) => !newIds.has(id));
    if (removedIds.length > 0) {
      await tx.delete(docBlocks).where(inArray(docBlocks.id, removedIds));
      await tx
        .delete(entryLinks)
        .where(
          and(eq(entryLinks.fromEntryId, unitEntryId), inArray(entryLinks.toEntryId, removedIds))
        );

      const notedRows = await tx
        .selectDistinct({ id: noteAnchors.blockEntryId })
        .from(noteAnchors)
        .where(inArray(noteAnchors.blockEntryId, removedIds));
      const notedIds = new Set(notedRows.map((row) => row.id));
      const deletableIds = removedIds.filter((id) => !notedIds.has(id));

      if (deletableIds.length > 0) {
        // A Memory note derived from a now-removed block keeps its `derived_from` provenance link pointing
        // at that block Entry; delete those links so the block Entry can be removed while the owned Memory
        // survives (detached). Chunks harvested from the block are detached, not deleted.
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

    await tx
      .update(personalEntries)
      .set({ updatedAt: now })
      .where(eq(personalEntries.entryId, workEntryId));

    return {
      status: "updated",
      work: {
        createdAt: owned.createdAt.toISOString(),
        document: withIds,
        entryId: toEntryId(workEntryId),
        language: owned.language,
        title: owned.title,
        unitEntryId,
        updatedAt: now.toISOString(),
        workType: owned.workType
      }
    };
  });
}
