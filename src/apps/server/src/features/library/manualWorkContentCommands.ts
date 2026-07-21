import { toEntryId, type EntryId } from "@whetstone/domain";
import type { ManualWorkDto } from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";
import { and, desc, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import {
  appendEditableWorkSection,
  reconcileEditableWorkContent
} from "../content/editableWorkContent.js";
import { normalizeManualWorkDocument } from "./manualWorkDocument.js";
import {
  loadManualWorkDocument,
  loadManualWorkSections,
  toManualWorkDto
} from "./manualWorkContentQueries.js";
import { personalEntries, readingUnits, workMeta } from "../../db/schema.js";

// The manual-Work editor's section writes are Library-owned commands, separate from the authored Writing
// save: they keep the manual Work's authorization (owner + `origin = 'manual'`) and add work-level
// revision protection the latest-write-safe authored path does not have. Real infrastructure (the DB, the
// clock, and id generation for a new section) is injected so the commands stay deterministic and testable.
// The shared rich-block reconciliation and section-append — id-preserving block diff with learner-material
// retention — are owned by the feature-neutral `editableWorkContent` boundary (#696/#697); these commands
// own the manual guard, the stale-revision check, the chronology bump, and section ordering.
export type ManualWorkContentDependencies = Readonly<{
  createEntryId: () => string;
  db: DbClient;
  now: () => Date;
}>;

// A save either lands (returning the reopened Work with a new revision and recomputed sections), is
// rejected because the caller does not own a manual Work by that id or the target section is not part of
// it, or is refused because the sent revision is stale — another session saved in between, so overwriting
// it would silently lose that write. The command never mutates on a conflict; the editor keeps its local
// document and can reload the current revision to reconcile.
export type UpdateManualWorkContentResult =
  | Readonly<{ status: "updated"; work: ManualWorkDto }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "conflict" }>;

// Adding a section either lands (returning the Work opened at the NEW section with a new revision and the
// recomputed section list), is rejected because the caller does not own a manual Work by that id, or is
// refused because the sent revision is stale. Same conflict semantics as a save.
export type AddManualWorkSectionResult =
  | Readonly<{ status: "added"; work: ManualWorkDto }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "conflict" }>;

type OwnedMeta = Readonly<{
  createdAt: Date;
  language: ManualWorkDto["language"];
  title: string;
  workType: ManualWorkDto["workType"];
}>;

type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// The Work-level authorization + metadata read shared by both commands: owner `personal_entries` facet AND
// `origin = 'manual'`. `undefined` for a forged id, another user's Work, an imported Work, or an authored
// Work — every one a 404 before any write.
async function findOwnedMeta(
  tx: Transaction,
  workEntryId: EntryId,
  userId: string
): Promise<OwnedMeta | undefined> {
  const [owned] = await tx
    .select({
      createdAt: personalEntries.createdAt,
      language: workMeta.language,
      title: workMeta.title,
      workType: workMeta.workType
    })
    .from(workMeta)
    .innerJoin(personalEntries, eq(personalEntries.entryId, workMeta.entryId))
    .where(
      and(
        eq(workMeta.entryId, workEntryId),
        eq(workMeta.origin, "manual"),
        eq(personalEntries.userId, userId)
      )
    )
    .limit(1);

  return owned;
}

// Claim the write atomically: the revision bump IS the stale-revision check. Folding both into one
// conditional `UPDATE ... WHERE updated_at = revision` closes the lost-update window a separate
// read-then-check leaves open. Under PostgreSQL read-committed, two saves that loaded the same revision
// would both pass a plain read, but only one wins this UPDATE — the loser's `updated_at = revision`
// predicate is re-evaluated (EvalPlanQual) against the winner's committed row and matches zero rows. A
// non-timestamp revision can never match a stored one, so it is definitionally stale. The new revision is
// written strictly greater than the loaded one, so a save whose clock did not advance cannot reuse the
// same token and let a stale replay overwrite it, making every successful revision monotonic. Returns the
// bumped revision instant, or `undefined` for a conflict (nothing written).
async function claimRevision(
  tx: Transaction,
  workEntryId: EntryId,
  userId: string,
  revision: string,
  now: Date
): Promise<Date | undefined> {
  const revisionInstant = new Date(revision);
  if (Number.isNaN(revisionInstant.getTime())) {
    return undefined;
  }

  const nextRevisionInstant = new Date(Math.max(now.getTime(), revisionInstant.getTime() + 1));

  const claimed = await tx
    .update(personalEntries)
    .set({ updatedAt: nextRevisionInstant })
    .where(
      and(
        eq(personalEntries.entryId, workEntryId),
        eq(personalEntries.userId, userId),
        eq(personalEntries.updatedAt, revisionInstant)
      )
    )
    .returning({ entryId: personalEntries.entryId });

  return claimed.length === 0 ? undefined : nextRevisionInstant;
}

// The document a new manual section starts from (#697): one empty Heading 1 block (so the section is a
// real, navigable outline node from creation — its level and text are then owned in the shared editor)
// followed by an empty paragraph for the body. Ids are stamped by the shared boundary on write.
function newSectionDocument(): DocumentNodeJSON {
  return {
    content: [{ attrs: { level: 1 }, type: "heading" }, { type: "paragraph" }],
    type: "doc"
  };
}

// Save one section's canonical document through the shared editable-Work boundary, which preserves the id
// of every surviving block so notes anchored to an unchanged block stay valid across saves and no review
// scheduling/history or learner-owned material is reset. Scoped to the owner via `personal_entries` AND
// `origin = 'manual'`, and the target section must belong to that Work: a forged id, another user's Work,
// an imported/authored Work, or a cross-work section is rejected (404) before any write. The loaded
// `revision` (the owner's last-write timestamp) must still be the stored one, or the save is a conflict
// and nothing is written. The whole claim-reconcile runs in one transaction, so a save never lands
// half-applied; the recomputed section list is read back after commit so the editor's Outline refreshes.
export async function updateManualWorkContent(
  dependencies: ManualWorkContentDependencies,
  workEntryId: EntryId,
  unitEntryId: EntryId,
  document: DocumentNodeJSON,
  revision: string,
  userId: string
): Promise<UpdateManualWorkContentResult> {
  const now = dependencies.now();

  const outcome = await dependencies.db.transaction(async (tx) => {
    const owned = await findOwnedMeta(tx, workEntryId, userId);
    if (owned === undefined) {
      return { status: "not_found" as const };
    }

    const [unit] = await tx
      .select({ entryId: readingUnits.entryId })
      .from(readingUnits)
      .where(and(eq(readingUnits.entryId, unitEntryId), eq(readingUnits.workEntryId, workEntryId)))
      .limit(1);
    if (unit === undefined) {
      return { status: "not_found" as const };
    }

    const nextRevisionInstant = await claimRevision(tx, workEntryId, userId, revision, now);
    if (nextRevisionInstant === undefined) {
      return { status: "conflict" as const };
    }

    await reconcileEditableWorkContent(tx, {
      document: normalizeManualWorkDocument(document),
      unitEntryId,
      workEntryId
    });

    return { owned, revision: nextRevisionInstant, status: "updated" as const };
  });

  if (outcome.status !== "updated") {
    return outcome;
  }

  return {
    status: "updated",
    work: await buildDto(dependencies.db, workEntryId, unitEntryId, outcome.owned, outcome.revision)
  };
}

// Append a new section (a new reading unit with a real heading block) to the manual Work and open it
// (#697). Same owner/origin authorization and revision protection as a save: a non-owner is a 404 and a
// stale revision is a conflict that writes nothing. The section is appended at the next order index, so
// ordering stays a dense, source-order sequence.
export async function addManualWorkSection(
  dependencies: ManualWorkContentDependencies,
  workEntryId: EntryId,
  revision: string,
  userId: string
): Promise<AddManualWorkSectionResult> {
  const now = dependencies.now();

  const outcome = await dependencies.db.transaction(async (tx) => {
    const owned = await findOwnedMeta(tx, workEntryId, userId);
    if (owned === undefined) {
      return { status: "not_found" as const };
    }

    const nextRevisionInstant = await claimRevision(tx, workEntryId, userId, revision, now);
    if (nextRevisionInstant === undefined) {
      return { status: "conflict" as const };
    }

    const [last] = await tx
      .select({ orderIndex: readingUnits.orderIndex })
      .from(readingUnits)
      .where(eq(readingUnits.workEntryId, workEntryId))
      .orderBy(desc(readingUnits.orderIndex))
      .limit(1);
    // A manual Work always has at least its seeded first section, so `last` is defined; the nullish
    // fallback keeps the arithmetic total without a separately-tested empty-Work branch.
    const nextOrderIndex = (last?.orderIndex ?? -1) + 1;

    const appended = await appendEditableWorkSection(tx, {
      createEntryId: dependencies.createEntryId,
      document: newSectionDocument(),
      orderIndex: nextOrderIndex,
      workEntryId
    });

    return {
      owned,
      revision: nextRevisionInstant,
      status: "added" as const,
      unitEntryId: appended.unitEntryId
    };
  });

  if (outcome.status !== "added") {
    return outcome;
  }

  return {
    status: "added",
    work: await buildDto(
      dependencies.db,
      workEntryId,
      toEntryId(outcome.unitEntryId),
      outcome.owned,
      outcome.revision
    )
  };
}

// Reassemble the editor DTO after a committed write: the recomputed section list plus the opened
// section's stored document, at the bumped revision. Read with the DB client (not the transaction) so it
// reflects exactly what was committed.
async function buildDto(
  db: DbClient,
  workEntryId: EntryId,
  unitEntryId: EntryId,
  owned: OwnedMeta,
  revision: Date
): Promise<ManualWorkDto> {
  const sections = await loadManualWorkSections(db, workEntryId);
  const document = await loadManualWorkDocument(db, unitEntryId);

  return toManualWorkDto(
    workEntryId,
    { ...owned, updatedAt: revision },
    unitEntryId,
    document,
    sections
  );
}
