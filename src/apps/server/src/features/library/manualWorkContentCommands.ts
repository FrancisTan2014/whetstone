import {
  planWorkSectionInsertion,
  toEntryId,
  type EntryId,
  type WorkSectionPlacement
} from "@whetstone/domain";
import type { ManualWorkDto } from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import {
  insertEditableWorkSection,
  repartitionEditableWorkContent
} from "../content/editableWorkContent.js";
import { claimWorkContentRevision } from "../content/workContentRevision.js";
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

// A contextual insertion can also reject a relation the canonical target cannot support (for example a
// child of H3). Like not-found and conflict, that refusal commits no revision or content write.
export type AddManualWorkSectionResult =
  | Readonly<{ status: "added"; work: ManualWorkDto }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "invalid_placement" }>
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

// Claim the Work's content revision atomically through the origin-neutral fence, then — only on a
// successful claim — bump the OWNER'S chronology (`personal_entries.updated_at`) in the SAME transaction.
// The compare-and-set IS the stale-revision check: the fence increments `work_meta.content_revision` only
// when the loaded token still matches, so two saves that loaded the same revision cannot both win. Content
// concurrency lives on the Work (origin-neutral, reusable by imported-Work correction), while chronology
// stays owner-only and is never a second revision truth. Returns the new revision and the bumped
// chronology instant, or `undefined` for a conflict (the fence claimed nothing, so neither the content
// revision nor the chronology is touched — a stale conflict or rollback changes neither).
async function claimContentRevision(
  tx: Transaction,
  workEntryId: EntryId,
  userId: string,
  revision: number,
  now: Date
): Promise<{ revision: number; updatedAt: Date } | undefined> {
  const claimed = await claimWorkContentRevision(tx, workEntryId, revision);
  if (claimed === undefined) {
    return undefined;
  }

  await tx
    .update(personalEntries)
    .set({ updatedAt: now })
    .where(and(eq(personalEntries.entryId, workEntryId), eq(personalEntries.userId, userId)));

  return { revision: claimed, updatedAt: now };
}

// Save one section's canonical document through the shared editable-Work boundary, which preserves the id
// of every surviving block so notes anchored to an unchanged block stay valid across saves and no review
// scheduling/history or learner-owned material is reset. Scoped to the owner via `personal_entries` AND
// `origin = 'manual'`, and the target section must belong to that Work: a forged id, another user's Work,
// an imported/authored Work, or a cross-work section is rejected (404) before any write. The loaded
// `revision` (the Work's `content_revision`) must still be the stored one, or the save is a conflict and
// nothing is written. The whole claim-reconcile runs in one transaction, so a save never lands
// half-applied; the recomputed section list is read back after commit so the editor's Outline refreshes.
//
// Deliberately repartitions rather than reconciles (#871): a manual Work's units are heading-led by
// construction (there is no external source division to preserve), so re-deriving unit boundaries from
// whatever headings the saved draft contains is correct, expected editor behavior here. This is the mirror
// image of `importedWorkContentCommands.ts`'s correction command, which reconciles a single unit in place
// specifically to preserve an imported Work's original, author-independent division — that divergence is
// intentional, not an oversight.
export async function updateManualWorkContent(
  dependencies: ManualWorkContentDependencies,
  workEntryId: EntryId,
  unitEntryId: EntryId,
  document: DocumentNodeJSON,
  revision: number,
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

    const claimed = await claimContentRevision(tx, workEntryId, userId, revision, now);
    if (claimed === undefined) {
      return { status: "conflict" as const };
    }

    // Substitute the saved section's draft into the Work's block stream and repartition the affected span
    // at heading boundaries (#698): a surviving leading heading keeps this unit's identity, a new heading
    // mints a unit, and removing the leading heading merges the section into the preceding unit. The
    // returned active unit is where the first draft block landed, so the editor stays on the edited
    // section (or follows it into the unit it merged into).
    const normalized = normalizeManualWorkDocument(document);
    const { activeUnitEntryId } = await repartitionEditableWorkContent(tx, {
      createEntryId: dependencies.createEntryId,
      document: normalized,
      editedUnitEntryId: unitEntryId,
      workEntryId
    });

    return { activeUnitEntryId, claimed, owned, status: "updated" as const };
  });

  if (outcome.status !== "updated") {
    return outcome;
  }

  return {
    status: "updated",
    work: await buildDto(
      dependencies.db,
      workEntryId,
      toEntryId(outcome.activeUnitEntryId),
      outcome.owned,
      outcome.claimed
    )
  };
}

// Insert a sibling or child from the target's canonical first-heading branch and open it (#881). The
// shared planner derives heading level and dense source-order index; the shared writer shifts later units.
export async function addManualWorkSection(
  dependencies: ManualWorkContentDependencies,
  workEntryId: EntryId,
  targetUnitEntryId: EntryId,
  placement: WorkSectionPlacement,
  revision: number,
  userId: string
): Promise<AddManualWorkSectionResult> {
  const now = dependencies.now();

  const outcome = await dependencies.db.transaction(async (tx) => {
    const owned = await findOwnedMeta(tx, workEntryId, userId);
    if (owned === undefined) {
      return { status: "not_found" as const };
    }

    const sections = await loadManualWorkSections(tx, workEntryId);
    const plan = planWorkSectionInsertion(sections, targetUnitEntryId, placement);
    if (plan.status === "target_not_found") {
      return { status: "not_found" as const };
    }
    if (plan.status === "invalid_placement") {
      return plan;
    }

    const claimed = await claimContentRevision(tx, workEntryId, userId, revision, now);
    if (claimed === undefined) {
      return { status: "conflict" as const };
    }

    const inserted = await insertEditableWorkSection(tx, {
      createEntryId: dependencies.createEntryId,
      headingLevel: plan.headingLevel,
      orderIndex: plan.orderIndex,
      workEntryId
    });

    return {
      claimed,
      owned,
      status: "added" as const,
      unitEntryId: inserted.unitEntryId
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
      outcome.claimed
    )
  };
}

// Reassemble the editor DTO after a committed write: the recomputed section list plus the opened
// section's stored document, at the newly-claimed content revision and bumped owner chronology. Read with
// the DB client (not the transaction) so it reflects exactly what was committed.
async function buildDto(
  db: DbClient,
  workEntryId: EntryId,
  unitEntryId: EntryId,
  owned: OwnedMeta,
  claimed: { revision: number; updatedAt: Date }
): Promise<ManualWorkDto> {
  const sections = await loadManualWorkSections(db, workEntryId);
  const document = await loadManualWorkDocument(db, unitEntryId);

  return toManualWorkDto(
    workEntryId,
    { ...owned, contentRevision: claimed.revision, updatedAt: claimed.updatedAt },
    unitEntryId,
    document,
    sections
  );
}
