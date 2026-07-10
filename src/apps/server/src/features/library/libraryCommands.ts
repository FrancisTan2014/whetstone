import { toAuthorId, toEntryId, type AuthorId, type EntryId } from "@whetstone/domain";
import type {
  AuthorDto,
  CreateAuthorRequest,
  CreateWorkRequest,
  WorkDto,
  WorkListItemDto
} from "@whetstone/contracts";
import { eq, inArray, or } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import {
  authors,
  blocks,
  chunks,
  docBlocks,
  entries,
  entryLinks,
  noteAnchors,
  notes,
  personalEntries,
  readingPositions,
  readingUnits,
  recallItems,
  tocEntries,
  workMeta,
  workSources
} from "../../db/schema.js";

// Real infrastructure boundaries (database client and id generation) are passed
// in so commands stay deterministic and testable.
export type LibraryDependencies = Readonly<{
  createAuthorId: () => string;
  createEntryId: () => string;
  db: DbClient;
}>;

export type CreateWorkResult =
  | Readonly<{ status: "created"; work: WorkListItemDto }>
  | Readonly<{ status: "author_not_found"; authorId: AuthorId }>;

// Deleting a work needs the DB (for the cascade transaction) plus the ability to unlink its retained
// source files after commit. The file unlink is injected as a narrow capability (not the whole store)
// and its failures are logged through an injected sink, so the command stays deterministic and testable
// and a filesystem error never rolls back the committed delete.
export type DeleteWorkDependencies = Readonly<{
  db: DbClient;
  deleteSourceFile: (relativePath: string) => Promise<void>;
  logSourceUnlinkFailure: (info: Readonly<{ error: unknown; filePath: string }>) => void;
}>;

export type DeleteWorkResult = "deleted" | "not_found";

export async function createAuthor(
  dependencies: LibraryDependencies,
  request: CreateAuthorRequest
): Promise<AuthorDto> {
  const id = toAuthorId(dependencies.createAuthorId());
  await dependencies.db.insert(authors).values({ id, name: request.name });

  return { id, name: request.name };
}

export async function createWork(
  dependencies: LibraryDependencies,
  request: CreateWorkRequest
): Promise<CreateWorkResult> {
  return dependencies.db.transaction(async (tx) => {
    const resolved = await resolveAuthor(dependencies, tx, request.author);

    if (!resolved.found) {
      return { status: "author_not_found", authorId: resolved.authorId };
    }

    const author = resolved.author;
    const entryId = toEntryId(dependencies.createEntryId());
    await tx.insert(entries).values({ id: entryId, type: "work" });
    await tx.insert(workMeta).values({
      authorId: author.id,
      entryId,
      language: request.language,
      title: request.title,
      workType: request.workType
    });

    const work: WorkDto = {
      authorId: author.id,
      entryId,
      language: request.language,
      title: request.title,
      workType: request.workType
    };

    return { status: "created", work: { author, work } };
  });
}

type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

type ResolvedAuthor =
  | Readonly<{ found: true; author: AuthorDto }>
  | Readonly<{ found: false; authorId: AuthorId }>;

async function resolveAuthor(
  dependencies: LibraryDependencies,
  tx: Transaction,
  selection: CreateWorkRequest["author"]
): Promise<ResolvedAuthor> {
  if (selection.mode === "new") {
    const id = toAuthorId(dependencies.createAuthorId());
    await tx.insert(authors).values({ id, name: selection.name });

    return { found: true, author: { id, name: selection.name } };
  }

  const existing = await tx
    .select()
    .from(authors)
    .where(eq(authors.id, selection.authorId))
    .limit(1);
  const found = existing[0];

  if (found === undefined) {
    return { found: false, authorId: selection.authorId };
  }

  return { found: true, author: { id: toAuthorId(found.id), name: found.name } };
}

// Permanently delete a work and everything it owns, in one transaction (#541). The cascade removes the
// work's reading units, blocks (legacy mdast + PM `doc_blocks`), authored TOC entries, `work_sources`,
// notes + their anchors, reading position, and the containment `entry_links`, then the `entries` rows
// themselves. Recall items that referenced a deleted block/note are PRESERVED with `provenance_entry_id`
// set to null (provenance is nullable by design), and any chunk harvested from a deleted block keeps its
// row with `source_block_entry_id` nulled — so the learner model / Map is never harmed. Works are shared
// content (no per-user owner column), so an unknown work id returns `not_found` (→ 404). The retained
// source file(s) are unlinked best-effort AFTER commit: a filesystem error is logged and never rolls the
// delete back.
export async function deleteWork(
  dependencies: DeleteWorkDependencies,
  workEntryId: EntryId
): Promise<DeleteWorkResult> {
  const outcome = await dependencies.db.transaction(async (tx) => {
    const work = await tx
      .select({ entryId: workMeta.entryId })
      .from(workMeta)
      .where(eq(workMeta.entryId, workEntryId))
      .limit(1);

    if (work[0] === undefined) {
      return { deleted: false as const };
    }

    const sourceRows = await tx
      .select({ filePath: workSources.filePath })
      .from(workSources)
      .where(eq(workSources.workEntryId, workEntryId));

    // The work's addressable block entries live in BOTH substrates (legacy `blocks` and PM `doc_blocks`),
    // each a first-class `entries` row a note / recall item / chunk may reference.
    const legacyBlockIds = (
      await tx
        .select({ id: blocks.entryId })
        .from(blocks)
        .where(eq(blocks.workEntryId, workEntryId))
    ).map((row) => row.id);
    const pmBlockIds = (
      await tx
        .select({ id: docBlocks.id })
        .from(docBlocks)
        .where(eq(docBlocks.workEntryId, workEntryId))
    ).map((row) => row.id);
    const blockIds = [...legacyBlockIds, ...pmBlockIds];

    const unitIds = (
      await tx
        .select({ id: readingUnits.entryId })
        .from(readingUnits)
        .where(eq(readingUnits.workEntryId, workEntryId))
    ).map((row) => row.id);
    const tocIds = (
      await tx
        .select({ id: tocEntries.entryId })
        .from(tocEntries)
        .where(eq(tocEntries.workEntryId, workEntryId))
    ).map((row) => row.id);

    // Notes annotate the work's blocks (a note is user-owned but its subject block is the work's), so a
    // work delete removes every note anchored to one of its blocks regardless of owner — otherwise the
    // note would dangle off a deleted block.
    const noteIds =
      blockIds.length === 0
        ? []
        : (
            await tx
              .selectDistinct({ id: noteAnchors.noteEntryId })
              .from(noteAnchors)
              .where(inArray(noteAnchors.blockEntryId, blockIds))
          ).map((row) => row.id);

    // Preserve recall/learner data: null the provenance link instead of deleting the item; keep any
    // harvested chunk but detach its source block. Both columns are nullable by design.
    const provenanceIds = [...blockIds, ...noteIds];
    if (provenanceIds.length > 0) {
      await tx
        .update(recallItems)
        .set({ provenanceEntryId: null })
        .where(inArray(recallItems.provenanceEntryId, provenanceIds));
    }
    if (blockIds.length > 0) {
      await tx
        .update(chunks)
        .set({ sourceBlockEntryId: null })
        .where(inArray(chunks.sourceBlockEntryId, blockIds));
    }

    if (noteIds.length > 0) {
      await tx.delete(noteAnchors).where(inArray(noteAnchors.noteEntryId, noteIds));
      await tx.delete(notes).where(inArray(notes.entryId, noteIds));
      // A note owns a `personal_entries` chronology facet (its owner + timestamps, #571); remove it before
      // the owning `entries` row so no ownership facet dangles off a deleted note.
      await tx.delete(personalEntries).where(inArray(personalEntries.entryId, noteIds));
    }

    await tx.delete(readingPositions).where(eq(readingPositions.workEntryId, workEntryId));

    const ownedEntryIds = [workEntryId, ...unitIds, ...blockIds, ...tocIds, ...noteIds];
    await tx
      .delete(entryLinks)
      .where(
        or(
          inArray(entryLinks.fromEntryId, ownedEntryIds),
          inArray(entryLinks.toEntryId, ownedEntryIds)
        )
      );

    await tx.delete(workSources).where(eq(workSources.workEntryId, workEntryId));
    await tx.delete(blocks).where(eq(blocks.workEntryId, workEntryId));
    await tx.delete(docBlocks).where(eq(docBlocks.workEntryId, workEntryId));
    await tx.delete(tocEntries).where(eq(tocEntries.workEntryId, workEntryId));
    await tx.delete(readingUnits).where(eq(readingUnits.workEntryId, workEntryId));
    await tx.delete(workMeta).where(eq(workMeta.entryId, workEntryId));
    await tx.delete(entries).where(inArray(entries.id, ownedEntryIds));

    const filePaths = sourceRows
      .map((row) => row.filePath)
      .filter((filePath): filePath is string => filePath !== null);

    return { deleted: true as const, filePaths };
  });

  if (!outcome.deleted) {
    return "not_found";
  }

  for (const filePath of outcome.filePaths) {
    try {
      await dependencies.deleteSourceFile(filePath);
    } catch (error) {
      dependencies.logSourceUnlinkFailure({ error, filePath });
    }
  }

  return "deleted";
}
