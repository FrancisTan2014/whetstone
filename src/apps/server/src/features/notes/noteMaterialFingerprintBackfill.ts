import { and, eq, isNull, sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { notes } from "../../db/schema.js";
import { fingerprintNoteMaterial } from "./noteMaterialFingerprint.js";

// The name of the NOT VALID shape constraint migration 0074 adds; this backfill VALIDATEs it once the
// legacy rows are filled.
const FINGERPRINT_SHAPE_CONSTRAINT = "notes_material_fingerprint_kind_ck";

// Raised when a legacy note body cannot be projected during backfill (an invalid document, an unsafe
// link, or a blank body-bearing note). It names the offending Entry so an operator can repair the one
// row, and — because it is thrown INSIDE the single backfill transaction — it rolls the whole backfill
// back, guaranteeing there is never a partial fingerprint state.
export class NoteMaterialBackfillError extends Error {
  constructor(noteEntryId: string, cause: unknown) {
    super(
      `Note ${noteEntryId} could not be fingerprinted during the material backfill: ${
        cause instanceof Error ? cause.message : String(cause)
      }. Repair this note's body and re-run; no fingerprints were written.`
    );
    this.name = "NoteMaterialBackfillError";
    this.cause = cause;
  }
}

// One-time backfill of `material_fingerprint` for legacy body-bearing notes (#711), run after
// `runMigrations` at server start. In a SINGLE transaction it fingerprints every `note` row that still
// holds NULL (composing the document-package projection — never re-deriving identity here), writes each
// fingerprint, then VALIDATEs the shape constraint migration 0074 added NOT VALID. It is idempotent —
// only NULL note rows are touched, and VALIDATE on an already-valid constraint is a no-op — so a restart
// re-runs it harmlessly. Marks (bodyless) are skipped by construction. An unprojectable body aborts the
// whole transaction (no partial backfill) with an actionable, row-named error. Returns how many rows
// were filled so the caller/tests can observe the work.
export async function backfillNoteMaterialFingerprints(db: DbClient): Promise<{ filled: number }> {
  return db.transaction(async (tx) => {
    const pending = await tx
      .select({ bodyDoc: notes.bodyDoc, entryId: notes.entryId })
      .from(notes)
      .where(and(eq(notes.kind, "note"), isNull(notes.materialFingerprint)));

    for (const row of pending) {
      let fingerprint: string;
      try {
        fingerprint = fingerprintNoteMaterial(row.bodyDoc);
      } catch (cause) {
        throw new NoteMaterialBackfillError(row.entryId, cause);
      }
      await tx
        .update(notes)
        .set({ materialFingerprint: fingerprint })
        .where(eq(notes.entryId, row.entryId));
    }

    await tx.execute(
      sql`alter table "notes" validate constraint "${sql.raw(FINGERPRINT_SHAPE_CONSTRAINT)}"`
    );

    return { filled: pending.length };
  });
}
