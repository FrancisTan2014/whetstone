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
  recitationChains,
  recitationPassages,
  recitationPlans,
  recitationWholeWork,
  tocEntries,
  workMeta,
  workSources
} from "../../db/schema.js";
import { resolveNamedAuthor } from "./authorResolver.js";
import { initializeEditableWorkContent } from "../content/editableWorkContent.js";
import { deleteRecitationReviewData } from "../recitation/recitationTeardown.js";

// Real infrastructure boundaries (database client and id generation) are passed
// in so commands stay deterministic and testable.
export type LibraryDependencies = Readonly<{
  createAuthorId: () => string;
  createEntryId: () => string;
  db: DbClient;
  now: () => Date;
}>;

export type CreateWorkResult =
  | Readonly<{ status: "created"; work: WorkListItemDto }>
  | Readonly<{ status: "author_not_found"; authorId: AuthorId }>;

// `createAuthor` resolves through the canonical identity boundary, so it reports whether it inserted a
// new row or matched an existing one — the route turns this into a truthful 201-vs-200 response (#694).
export type CreateAuthorResult = Readonly<{ author: AuthorDto; created: boolean }>;

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
): Promise<CreateAuthorResult> {
  return dependencies.db.transaction((tx) =>
    resolveNamedAuthor(tx, dependencies.createAuthorId, request.name)
  );
}

// Create a Work from the caller's explicit content-authority intent (#695), replacing the one ambiguous
// command that served both manual metadata and pending uploads. The request's `origin` is `manual` (a
// learner-curated Work) or `imported` (an upload shell ingestion later fills); it is stamped on the Work
// in the same transaction. A `manual` Work is the learner's own curation, so it also gets a
// `personal_entries` ownership/chronology facet (server-owned timestamps, so the client cannot backdate
// it) — imported shells get none. `authored` is never created here (only the Writing path mints owned
// writing), so this endpoint cannot forge an owned Work.
export async function createWork(
  dependencies: LibraryDependencies,
  request: CreateWorkRequest,
  userId: string
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
      origin: request.origin,
      title: request.title,
      workType: request.workType
    });

    if (request.origin === "manual") {
      const now = dependencies.now();
      await tx
        .insert(personalEntries)
        .values({ createdAt: now, entryId, occurredAt: now, updatedAt: now, userId });

      // A manual Work is editable from the first moment (#720): initialize its canonical content — one
      // reading unit and one empty, id-stamped paragraph with its Entry/containment graph — through the
      // shared editable-Work boundary, in this same creation transaction. It carries no imported source;
      // its document is edited only through the manual-Work editor, never legacy Markdown ingestion.
      await initializeEditableWorkContent(tx, {
        createEntryId: dependencies.createEntryId,
        workEntryId: entryId
      });
    }

    const work: WorkDto = {
      authorId: author.id,
      entryId,
      language: request.language,
      origin: request.origin,
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
    const resolved = await resolveNamedAuthor(tx, dependencies.createAuthorId, selection.name);

    return { found: true, author: resolved.author };
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

    // A Memory note derived from one of the work's blocks/notes keeps its `derived_from` provenance link;
    // that link's target is among `ownedEntryIds`, so the bulk `entry_links` delete below detaches it,
    // preserving the owned Memory while dropping the dangling provenance. Only chunks need explicit
    // detaching (their FK column is nullable by design).
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

    // A learner may have adopted this Work as a recitation routine (#577): each plan is an owned Entry
    // whose `recitation_plans` facet has an FK to the Work's Entry, so it must be torn down before the
    // Work Entry is deleted. Remove the facet row, then its `personal_entries` chronology facet, then the
    // owning `entries` row — otherwise the FK blocks the delete and the Work is stuck in the Library.
    const recitationPlanIds = (
      await tx
        .select({ id: recitationPlans.entryId })
        .from(recitationPlans)
        .where(eq(recitationPlans.workEntryId, workEntryId))
    ).map((row) => row.id);
    if (recitationPlanIds.length > 0) {
      // Each plan may have been divided into recitation passages (#578) and may own a whole-Work
      // aggregate target (#605). All scheduling now lives on the shared review-card substrate (#618):
      // passages and the whole-Work target are review-card targets, and the cue-strength evidence keys to
      // their events. Tear down, referentially safe: each target's cards + events + evidence, then the
      // passage rows + their `entries`, the whole-Work target rows + `contains` links + `entries`, and any
      // active/completed chains — all before the plans and blocks, or the FKs block the Work delete.
      const passageIds = (
        await tx
          .select({ id: recitationPassages.entryId })
          .from(recitationPassages)
          .where(inArray(recitationPassages.planEntryId, recitationPlanIds))
      ).map((row) => row.id);
      if (passageIds.length > 0) {
        await deleteRecitationReviewData(tx, passageIds);
        await tx.delete(recitationPassages).where(inArray(recitationPassages.entryId, passageIds));
        await tx.delete(entries).where(inArray(entries.id, passageIds));
      }

      // The whole-Work aggregate is its own target Entry (type `recitation_whole_work`), linked to its
      // plan by a `contains` entry-link (#618). Remove its shared card/event/evidence, the link, the
      // facet row, then the target `entries` row.
      const wholeWorkTargetIds = (
        await tx
          .select({ id: recitationWholeWork.entryId })
          .from(recitationWholeWork)
          .where(inArray(recitationWholeWork.planEntryId, recitationPlanIds))
      ).map((row) => row.id);
      if (wholeWorkTargetIds.length > 0) {
        await deleteRecitationReviewData(tx, wholeWorkTargetIds);
        await tx.delete(entryLinks).where(inArray(entryLinks.toEntryId, wholeWorkTargetIds));
        await tx
          .delete(recitationWholeWork)
          .where(inArray(recitationWholeWork.entryId, wholeWorkTargetIds));
        await tx.delete(entries).where(inArray(entries.id, wholeWorkTargetIds));
      }

      // Any open or completed chain FKs the plan; drop them before the plans.
      await tx
        .delete(recitationChains)
        .where(inArray(recitationChains.planEntryId, recitationPlanIds));

      await tx.delete(recitationPlans).where(inArray(recitationPlans.entryId, recitationPlanIds));
      await tx.delete(personalEntries).where(inArray(personalEntries.entryId, recitationPlanIds));
      await tx.delete(entries).where(inArray(entries.id, recitationPlanIds));
    }

    // An authored (owned) Work carries its own `personal_entries` chronology facet (#576); remove it with
    // the Work so no ownership row dangles off the deleted Entry. A no-op for an imported Work (none exists).
    await tx.delete(personalEntries).where(eq(personalEntries.entryId, workEntryId));

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
