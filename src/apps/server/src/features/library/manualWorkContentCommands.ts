import { toEntryId, type EntryId } from "@whetstone/domain";
import type { ManualWorkDto } from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";
import { and, asc, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { reconcileEditableWorkContent } from "../content/editableWorkContent.js";
import { normalizeManualWorkDocument } from "./manualWorkDocument.js";
import { docBlocks, personalEntries, readingUnits, workMeta } from "../../db/schema.js";

// The manual-Work editor's save is a Library-owned command, separate from the authored Writing save: it
// keeps the manual Work's authorization (owner + `origin = 'manual'`) and adds revision protection the
// latest-write-safe authored path does not have. Real infrastructure (the DB and the clock) is injected so
// the command stays deterministic and testable. The shared rich-block reconciliation — id-preserving
// block diff with learner-material retention — is owned by the feature-neutral `editableWorkContent`
// boundary (#696); this command owns the manual guard, the stale-revision check, and the chronology bump.
export type ManualWorkContentDependencies = Readonly<{
  db: DbClient;
  now: () => Date;
}>;

// A save either lands (returning the reopened Work with a new revision), is rejected because the caller
// does not own a manual Work by that id, or is refused because the sent revision is stale — another
// session saved in between, so overwriting it would silently lose that write. The command never mutates on
// a conflict; the editor keeps its local document and can reload the current revision to reconcile.
export type UpdateManualWorkContentResult =
  | Readonly<{ status: "updated"; work: ManualWorkDto }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "conflict" }>;

// Save a manual Work's canonical document through the shared editable-Work boundary, which preserves the
// id of every surviving block so notes anchored to an unchanged block stay valid across saves and no
// review scheduling/history or learner-owned material is reset. Scoped to the owner via `personal_entries`
// AND `origin = 'manual'`: a forged id, another user's Work, an imported Work, or an authored Work is
// rejected (404) before any write. The loaded `revision` (the owner's last-write timestamp) must still be
// the stored one, or the save is a conflict and nothing is written. The revision check is the revision
// bump: a single conditional `UPDATE ... WHERE updated_at = revision` claims the write atomically, so two
// saves that loaded the same revision cannot both win — the loser matches zero rows and is a conflict
// (see the claim step). The new revision is written strictly greater than the loaded one, so a save whose
// clock did not advance cannot reuse the same token and let a stale replay overwrite it. The whole
// claim-reconcile runs in one transaction, so a save never lands half-applied.
export async function updateManualWorkContent(
  dependencies: ManualWorkContentDependencies,
  workEntryId: EntryId,
  document: DocumentNodeJSON,
  revision: string,
  userId: string
): Promise<UpdateManualWorkContentResult> {
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
          eq(workMeta.origin, "manual"),
          eq(personalEntries.userId, userId)
        )
      )
      .limit(1);

    if (owned === undefined) {
      return { status: "not_found" };
    }

    // The revision is the owner's last-write timestamp; a value that is not a timestamp can never match a
    // stored one, so it is definitionally stale — a conflict, never a crash on `new Date("…")`.
    const revisionInstant = new Date(revision);
    if (Number.isNaN(revisionInstant.getTime())) {
      return { status: "conflict" };
    }

    // The written revision must be STRICTLY greater than the loaded one, or the token is reusable: if the
    // clock did not advance past the loaded revision — two saves in the same millisecond of `Date`
    // precision, or a fixed/test clock — writing `now` back stores the same timestamp the claim just
    // matched, so a second request carrying that same stale revision would still match and silently
    // overwrite this save. Bumping to at least 1ms past the claimed revision makes every successful save's
    // revision monotonic and non-reusable, so a stale revision can never be replayed.
    const nextRevisionInstant = new Date(Math.max(now.getTime(), revisionInstant.getTime() + 1));

    // Claim the write atomically: the revision bump IS the stale-revision check. Folding both into one
    // conditional `UPDATE ... WHERE updated_at = revision` closes the lost-update window a separate
    // read-then-check leaves open. Under PostgreSQL read-committed, two saves that loaded the same revision
    // would both pass a plain read, but only one wins this UPDATE — the loser's `updated_at = revision`
    // predicate is re-evaluated (EvalPlanQual) against the winner's committed row and matches zero rows.
    // Zero affected rows is a conflict, and because this precedes the reconcile, a conflict writes nothing.
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

    if (claimed.length === 0) {
      return { status: "conflict" };
    }

    await reconcileEditableWorkContent(tx, {
      document: normalizeManualWorkDocument(document),
      unitEntryId: owned.unitEntryId,
      workEntryId
    });

    const blockRows = await tx
      .select({ node: docBlocks.nodeJson, orderIndex: docBlocks.orderIndex })
      .from(docBlocks)
      .where(eq(docBlocks.readingUnitEntryId, owned.unitEntryId))
      .orderBy(asc(docBlocks.orderIndex));

    const stored: DocumentNodeJSON = {
      content: blockRows.map((row) => row.node as DocumentNodeJSON),
      type: "doc"
    };

    return {
      status: "updated",
      work: {
        createdAt: owned.createdAt.toISOString(),
        document: stored,
        entryId: toEntryId(workEntryId),
        language: owned.language,
        revision: nextRevisionInstant.toISOString(),
        title: owned.title,
        unitEntryId: owned.unitEntryId,
        updatedAt: nextRevisionInstant.toISOString(),
        workType: owned.workType
      }
    };
  });
}
