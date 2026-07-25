import { projectNearMatchKey } from "@whetstone/document";
import { and, eq, isNull } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { notes } from "../../db/schema.js";

// One-time backfill of the near-match key columns (`relaxed_key`, `relaxed_key_length`) for legacy
// body-bearing notes (#713), run after `runMigrations` at server start. In a SINGLE transaction it projects
// every `note` row whose key is still NULL — composing the document-package near-match projection, never
// re-deriving eligibility here — and, for the ELIGIBLE ones, writes the relaxed key and its code-point
// length. An unsupported note (a single word, non-ASCII, structural, or out-of-band body) projects to
// `null`, so it is left with both columns NULL: near matching stays silent on it, exactly as at write time.
//
// The columns' pair constraint is added VALID in migration 0076 (the freshly-added columns are all-NULL,
// which already satisfies it), so unlike the fingerprint backfill there is no NOT VALID constraint to
// VALIDATE here. The projection never throws on a bad body — it returns `null` — so a corrupt legacy note
// cannot abort the backfill; it is simply treated as unsupported. The pass is idempotent: an eligible note
// filled once is no longer NULL and is skipped next time; only marks and genuinely-unsupported notes remain
// NULL, and re-projecting those is a cheap, write-free no-op. Returns how many rows were filled.
export async function backfillNoteNearMatchKeys(db: DbClient): Promise<{ filled: number }> {
  return db.transaction(async (tx) => {
    const pending = await tx
      .select({ bodyDoc: notes.bodyDoc, entryId: notes.entryId })
      .from(notes)
      .where(and(eq(notes.kind, "note"), isNull(notes.relaxedKey)));

    let filled = 0;
    for (const row of pending) {
      const key = projectNearMatchKey(row.bodyDoc);
      if (key === null) {
        continue;
      }
      await tx
        .update(notes)
        .set({ relaxedKey: key.relaxedKey, relaxedKeyLength: key.codePointLength })
        .where(eq(notes.entryId, row.entryId));
      filled += 1;
    }

    return { filled };
  });
}
