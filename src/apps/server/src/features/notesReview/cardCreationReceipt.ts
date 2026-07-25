import { createHash } from "node:crypto";

import type { DirectCardResultDto } from "@whetstone/contracts";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { cardCreationReceipts, personalEntries, reviewCards } from "../../db/schema.js";
import { reviewStateFromCard } from "../review/reviewCardQueries.js";

// The user-scoped card-creation receipt boundary (#689, extended by #687): the single place that makes
// authored card creation retry-safe. Both the standalone direct-card command (#689, which mints a new note)
// and the saved-note first-card command (#687, which authors over an existing note) claim ONE receipt per
// `submissionId`, so a lost response replays exactly one creation and a changed-payload replay is a
// deterministic conflict — never a duplicated card or a database error. Only an opaque payload fingerprint
// is persisted, never the learning content, and the receipt has no foreign key into the note cascade, so a
// deleted note leaves it behind as a non-resurrecting tombstone.

// The transaction handle drizzle passes into `db.transaction`, so the whole claim-or-replay decision runs
// in ONE atomic write.
type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// A canonical, key-sorted serialization of any JSON value, so two logically equal payloads hash identically
// regardless of object-key order. Used only to feed the fingerprint digest.
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${canonicalize(val)}`).join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

// A non-reversible fingerprint of a submission's payload, so a replay with the SAME `submissionId` can be
// classified as an identical retry (same fingerprint) or a changed-payload conflict (different fingerprint)
// WITHOUT persisting any learning content: only this opaque sha256 digest is stored, never the documents
// themselves. Each command passes the payload that defines its identity (the direct-card command hashes the
// answer, question, and target; the saved-note command hashes the note id, question, and target).
export function fingerprintPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
}

// Claim the receipt for one submission as the FIRST write of the creating transaction: the first submission
// wins the insert; a retry (or a concurrent loser) inserts nothing and must fall through to
// `resolveReceiptReplay`. Serializes concurrent/sequential retries on the receipt's primary key. Returns
// whether this caller claimed the receipt (and therefore must perform the genuine create).
export async function claimReceipt(
  tx: Transaction,
  receipt: Readonly<{
    createdAt: Date;
    noteEntryId: string;
    payloadFingerprint: string;
    promptEntryId: string;
    submissionId: string;
    userId: string;
  }>
): Promise<boolean> {
  const claimed = await tx
    .insert(cardCreationReceipts)
    .values(receipt)
    .onConflictDoNothing()
    .returning({ noteEntryId: cardCreationReceipts.noteEntryId });
  return claimed.length > 0;
}

// Whether the receipt's original note still exists for this owner. A deleted note leaves the receipt behind
// as a non-resurrecting tombstone (the receipt has no foreign key into the note's cascade), so a replay of
// a deleted result reads `gone` here instead of resurrecting it.
async function noteStillExists(
  tx: Transaction,
  noteEntryId: string,
  userId: string
): Promise<boolean> {
  const rows = await tx
    .select({ entryId: personalEntries.entryId })
    .from(personalEntries)
    .where(and(eq(personalEntries.entryId, noteEntryId), eq(personalEntries.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

// The resolution of a replay whose receipt was already claimed by an earlier submission: the same payload
// returns the ORIGINAL result (`ok`); a changed payload is a `conflict`; a replay whose note has since been
// deleted — or whose seeded card was removed on its own (e.g. an unenroll) — is `gone`, because the result
// cannot be reconstructed and the tombstone never resurrects it.
export type ReceiptReplay =
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "gone" }>
  | Readonly<{ kind: "ok"; value: DirectCardResultDto }>;

// Resolve a replay ONLY when a receipt for this (owner, submission) already exists, else `null`. The New-card
// save (#712) consults this at the TOP of its transaction — before the material-review gate — so a retry of
// an already-created card replays its original result instead of re-matching the just-created note as
// "existing material" and looping back into review. Returns the classified replay (`ok`/`conflict`/`gone`)
// exactly as `resolveReceiptReplay`, or `null` when there is no receipt to replay.
export async function findReceiptReplay(
  tx: Transaction,
  params: Readonly<{ userId: string; submissionId: string; fingerprint: string }>
): Promise<ReceiptReplay | null> {
  const existingRows = await tx
    .select({
      noteEntryId: cardCreationReceipts.noteEntryId,
      payloadFingerprint: cardCreationReceipts.payloadFingerprint,
      promptEntryId: cardCreationReceipts.promptEntryId
    })
    .from(cardCreationReceipts)
    .where(
      and(
        eq(cardCreationReceipts.userId, params.userId),
        eq(cardCreationReceipts.submissionId, params.submissionId)
      )
    )
    .limit(1);
  const existing = existingRows[0];
  if (existing === undefined) {
    return null;
  }
  if (existing.payloadFingerprint !== params.fingerprint) {
    return { kind: "conflict" };
  }
  if (!(await noteStillExists(tx, existing.noteEntryId, params.userId))) {
    return { kind: "gone" };
  }

  const cards = await tx
    .select()
    .from(reviewCards)
    .where(
      and(
        eq(reviewCards.targetEntryId, existing.promptEntryId),
        eq(reviewCards.userId, params.userId)
      )
    )
    .limit(1);
  const card = cards[0];
  if (card === undefined) {
    return { kind: "gone" };
  }
  return {
    kind: "ok",
    value: {
      noteId: existing.noteEntryId,
      promptId: existing.promptEntryId,
      review: reviewStateFromCard(card)
    }
  };
}

// The resolution of a replay whose receipt was already claimed by an earlier submission: the same payload
// returns the ORIGINAL result (`ok`); a changed payload is a `conflict`; a replay whose note has since been
// deleted — or whose seeded card was removed on its own (e.g. an unenroll) — is `gone`, because the result
// cannot be reconstructed and the tombstone never resurrects it. Called only AFTER a failed claim, so a
// receipt row always exists.
export async function resolveReceiptReplay(
  tx: Transaction,
  params: Readonly<{ userId: string; submissionId: string; fingerprint: string }>
): Promise<ReceiptReplay> {
  const replay = await findReceiptReplay(tx, params);
  /* v8 ignore next -- resolveReceiptReplay runs only after `claimReceipt` returned false, so the receipt row
     necessarily exists; the null case is unreachable here and belongs to `findReceiptReplay`'s own callers. */
  return replay ?? { kind: "conflict" };
}
