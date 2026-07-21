import { toEntryId, type EntryId } from "@whetstone/domain";
import type { AuthoredWorkDto, CreateAuthoredWorkRequest } from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import {
  initializeEditableWorkContent,
  reconcileEditableWorkContent
} from "../content/editableWorkContent.js";
import { authors, entries, personalEntries, readingUnits, workMeta } from "../../db/schema.js";

// Real infrastructure boundaries (db, id generation, the clock) are injected so the authored-work
// commands stay deterministic and testable. Authoring a Work reuses the ingested-content substrate: an
// owned Work is stored as the same `entries`/`work_meta`/`reading_units`/`doc_blocks` rows an imported
// Work is, plus a `personal_entries` facet that marks it owned and orders it on the learner's Timeline. The
// shared rich-block storage (unit + block initialization and reconciliation) is owned by the feature-neutral
// `editableWorkContent` boundary; these commands own authorization, origin/owner guards, and lifecycle.
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

// Create an owned Work and open it empty: one transaction writes the get-or-create self author, the
// `entries(work)` + `work_meta` metadata, and the `personal_entries` ownership+chronology facet (occurred =
// created = updated = now, server-owned so the client cannot backdate it), then delegates the Work's initial
// content — one `reading_units` row and one empty paragraph `doc_blocks` block — to the shared editable-Work
// boundary. The returned document is the stamped initial document, so the editor loads a valid,
// note-addressable document from the first save.
export async function createAuthoredWork(
  dependencies: AuthoredWorkDependencies,
  request: CreateAuthoredWorkRequest,
  userId: string
): Promise<AuthoredWorkDto> {
  const now = dependencies.now();
  const workEntryId = toEntryId(dependencies.createEntryId());
  const selfAuthorId = selfAuthorIdFor(userId);

  const { document, unitEntryId } = await dependencies.db.transaction(async (tx) => {
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
      origin: "authored",
      title: request.title,
      workType: request.workType
    });
    await tx
      .insert(personalEntries)
      .values({ createdAt: now, entryId: workEntryId, occurredAt: now, updatedAt: now, userId });

    return initializeEditableWorkContent(tx, {
      createEntryId: dependencies.createEntryId,
      workEntryId
    });
  });

  const iso = now.toISOString();
  return {
    createdAt: iso,
    document,
    entryId: workEntryId,
    language: request.language,
    title: request.title,
    unitEntryId,
    updatedAt: iso,
    workType: request.workType
  };
}

// Save an authored Work's canonical document (latest-write-safe) through the shared editable-Work boundary,
// which preserves the id of every surviving block so notes anchored to an unchanged block stay valid across
// saves. Scoped to the owner via `personal_entries` AND `origin = 'authored'` (#695): a forged id, another
// user's Work, an imported Work, or a `manual` Work (which also carries `personal_entries`) is rejected
// (404) before any write. The whole reconcile runs in one transaction so a save never lands half-applied.
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
      .where(
        and(
          eq(workMeta.entryId, workEntryId),
          eq(workMeta.origin, "authored"),
          eq(personalEntries.userId, userId)
        )
      )
      .limit(1);

    if (owned === undefined) {
      return { status: "not_found" };
    }

    const unitEntryId = owned.unitEntryId;

    const { document: withIds } = await reconcileEditableWorkContent(tx, {
      document,
      unitEntryId,
      workEntryId
    });

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
