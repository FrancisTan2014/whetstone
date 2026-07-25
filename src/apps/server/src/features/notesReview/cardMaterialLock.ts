import { sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";

// The transaction handle drizzle passes into `db.transaction`. The lock is a TRANSACTION-scoped advisory
// lock, so it is held for exactly the life of this transaction and released automatically on commit or
// rollback — there is nothing to unlock and no lock can leak.
type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// Serialize the material review for one owner + drafted material inside the save/decision transaction
// (#712). Two concurrent saves of the SAME Answer would otherwise each project, find no existing match, and
// each mint a note — the very duplication this feature prevents. Taking a per-(owner, material) advisory
// lock makes them run one at a time: the first creates the note; the second, now holding the lock, reprojects
// and sees the just-created note as a match, so it returns `needs_material_review` instead of a second copy.
//
// The lock key is derived from the owner and the drafted material's fingerprint via `hashtext` — an opaque,
// content-free pair of integers — so it never leaks draft content and never collides across owners in
// practice. It is advisory (a pure serialization primitive) and transaction-scoped, so it neither blocks
// unrelated writes nor survives the transaction.
export async function acquireCardMaterialLock(
  tx: Transaction,
  userId: string,
  materialFingerprint: string
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${userId}), hashtext(${materialFingerprint}))`
  );
}
