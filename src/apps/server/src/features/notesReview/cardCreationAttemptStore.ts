import { NEAR_MATCH_EVIDENCE_VERSION } from "@whetstone/document";
import type { DocumentNodeJSON } from "@whetstone/document";
import type { NoteGradingTarget } from "@whetstone/contracts";
import { and, eq, lte } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { cardCreationAttempts } from "../../db/schema.js";
import { fingerprintPayload } from "./cardCreationReceipt.js";

// The store for the owner-scoped, expiring `card_creation_attempt` (#712): the operational row that binds
// one pending material review so a follow-on Use existing / Keep separate decision is authoritative and
// fenced. It persists no learning content — only opaque fingerprints and the reviewed candidate ids — and
// has no foreign key into the note cascade, so a deleted candidate simply fails a later recheck. Every
// transition is compare-and-set fenced by the row's `revision`, so a stale client or a replayed decision is
// rejected, never reapplied. A local-MCP preview (#717) reuses the SAME row with `source: "mcp"`, additionally
// staging the exact drafted documents in `draftPayload` for a later commit; it never writes a card.

// The transaction handle drizzle passes into `db.transaction`, so a decision's lock, recheck, consume, and
// write run in ONE atomic write.
type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// A reader that both the top-level client and an open transaction satisfy, so the attempt reads compose
// inside a decision's transaction as well as standalone.
type Reader = Pick<DbClient, "select">;

export type CardCreationDecision = "keep_separate" | "reuse" | "create";

// Where a review/preview attempt was raised: `ui` for the in-app New-card save (#712), `mcp` for a local-MCP
// preview (#717).
export type CardCreationAttemptSource = "ui" | "mcp";

// The exact drafted documents an `mcp` preview stages so a later commit issue can recreate precisely the
// previewed card without trusting the client to resend it. A `ui` attempt stages nothing (null): its composer
// resends the draft on the decision.
export type CardCreationDraftPayload = Readonly<{
  answerDoc: DocumentNodeJSON;
  questionDoc: DocumentNodeJSON;
  target: NoteGradingTarget;
}>;

// The in-memory shape of one attempt row.
export type CardCreationAttemptRecord = Readonly<{
  candidateFingerprint: string;
  candidateNoteIds: ReadonlyArray<string>;
  decision: CardCreationDecision | null;
  draftFingerprint: string;
  draftPayload: CardCreationDraftPayload | null;
  expiresAt: Date;
  id: string;
  revision: number;
  source: CardCreationAttemptSource;
  state: "consumed" | "pending";
  submissionId: string;
  userId: string;
}>;

type AttemptRow = typeof cardCreationAttempts.$inferSelect;

function toRecord(row: AttemptRow): CardCreationAttemptRecord {
  return {
    candidateFingerprint: row.candidateFingerprint,
    candidateNoteIds: row.candidateNoteIds,
    decision: row.decision,
    draftFingerprint: row.draftFingerprint,
    draftPayload: (row.draftPayload as CardCreationDraftPayload | null) ?? null,
    expiresAt: row.expiresAt,
    id: row.id,
    revision: row.revision,
    source: row.source,
    state: row.state,
    submissionId: row.submissionId,
    userId: row.userId
  };
}

// The two disjoint reviewed candidate groups an attempt binds (#712, #714): exact material already in Notes,
// and high-precision "Possible duplicate" near matches. Each list is in the stable order its matcher
// produced. `nearKeys` are the near candidates' case-sensitive relaxed keys, in the SAME order as
// `nearNoteIds` — the stable material projection the "Possible duplicate" differences/excerpt are derived
// from. Passed together so one fingerprint fences BOTH groups, the near candidates' reviewed CONTENT, and
// the near evidence policy.
export type ReviewCandidateGroups = Readonly<{
  exactNoteIds: ReadonlyArray<string>;
  nearNoteIds: ReadonlyArray<string>;
  nearKeys: ReadonlyArray<string>;
}>;

// The opaque digest of the reviewed candidate set — the ordered exact ids, the ordered near ids, the ordered
// near candidate keys, and the near evidence-policy version — so a new/changed/deleted candidate in EITHER
// group, a same-id near candidate whose reviewed wording was edited underneath the panel, or a policy change
// that reweights near evidence, is detected on a decision recheck without persisting any content. Order
// matters within each group: both matchers return a stable order, so the same candidate set always hashes the
// same and a genuine change always differs. Binding the near keys means a same-id edit that changes the
// displayed "Possible duplicate" differences/excerpt re-parks the review; folding the evidence version means a
// parked review refreshes when the near policy that produced its differences changes underneath it.
export function fingerprintReviewCandidates(groups: ReviewCandidateGroups): string {
  return fingerprintPayload({
    evidenceVersion: NEAR_MATCH_EVIDENCE_VERSION,
    exactNoteIds: [...groups.exactNoteIds],
    nearKeys: [...groups.nearKeys],
    nearNoteIds: [...groups.nearNoteIds]
  });
}

// The combined candidate ids persisted on the row for provenance and the reuse-membership check: exact first,
// then near, in each matcher's stable order.
function combinedCandidateNoteIds(groups: ReviewCandidateGroups): string[] {
  return [...groups.exactNoteIds, ...groups.nearNoteIds];
}

export type InsertPendingAttemptInput = Readonly<{
  draftFingerprint: string;
  draftPayload: CardCreationDraftPayload | null;
  exactNoteIds: ReadonlyArray<string>;
  expiresAt: Date;
  id: string;
  nearNoteIds: ReadonlyArray<string>;
  nearKeys: ReadonlyArray<string>;
  now: Date;
  source: CardCreationAttemptSource;
  submissionId: string;
  userId: string;
}>;

// Create the single pending review attempt for one (owner, submission). The candidate fingerprint is
// computed here from both groups (never trusted from a caller). A second concurrent pending attempt for the
// same (owner, submission) violates the partial-unique index and throws, so the "one pending review per save"
// invariant is the database's, not only the caller's.
export async function insertPendingCardCreationAttempt(
  tx: Transaction,
  input: InsertPendingAttemptInput
): Promise<CardCreationAttemptRecord> {
  const [row] = await tx
    .insert(cardCreationAttempts)
    .values({
      candidateFingerprint: fingerprintReviewCandidates(input),
      candidateNoteIds: combinedCandidateNoteIds(input),
      createdAt: input.now,
      decision: null,
      draftFingerprint: input.draftFingerprint,
      draftPayload: input.draftPayload,
      expiresAt: input.expiresAt,
      id: input.id,
      revision: 0,
      source: input.source,
      state: "pending",
      submissionId: input.submissionId,
      updatedAt: input.now,
      userId: input.userId
    })
    .returning();
  return toRecord(row!);
}

// The owner's single PENDING attempt for one submission, if any — the row the partial-unique index
// guarantees is unique. A save retry loads this to resume the same review instead of minting a second.
export async function getPendingAttemptForSubmission(
  reader: Reader,
  userId: string,
  submissionId: string
): Promise<CardCreationAttemptRecord | null> {
  const [row] = await reader
    .select()
    .from(cardCreationAttempts)
    .where(
      and(
        eq(cardCreationAttempts.userId, userId),
        eq(cardCreationAttempts.submissionId, submissionId),
        eq(cardCreationAttempts.state, "pending")
      )
    );
  return row === undefined ? null : toRecord(row);
}

// One attempt scoped to its owner and id — the authorization for a decision. `null` means no such attempt
// for this owner (a forged or cross-owner id).
export async function getCardCreationAttempt(
  reader: Reader,
  userId: string,
  id: string
): Promise<CardCreationAttemptRecord | null> {
  const [row] = await reader
    .select()
    .from(cardCreationAttempts)
    .where(and(eq(cardCreationAttempts.id, id), eq(cardCreationAttempts.userId, userId)));
  return row === undefined ? null : toRecord(row);
}

export type RefreshReviewInput = Readonly<{
  exactNoteIds: ReadonlyArray<string>;
  expectedRevision: number;
  id: string;
  nearNoteIds: ReadonlyArray<string>;
  nearKeys: ReadonlyArray<string>;
  now: Date;
  userId: string;
}>;

// Update a still-`pending` attempt's reviewed candidate set, bumping the revision so any client holding the
// old revision is fenced out. Recomputes the candidate fingerprint here from both groups. Returns the updated
// record, or null when the compare-and-set missed — a stale revision, or an attempt that already left
// `pending`.
export async function refreshAttemptReview(
  tx: Transaction,
  input: RefreshReviewInput
): Promise<CardCreationAttemptRecord | null> {
  const [row] = await tx
    .update(cardCreationAttempts)
    .set({
      candidateFingerprint: fingerprintReviewCandidates(input),
      candidateNoteIds: combinedCandidateNoteIds(input),
      revision: input.expectedRevision + 1,
      updatedAt: input.now
    })
    .where(
      and(
        eq(cardCreationAttempts.id, input.id),
        eq(cardCreationAttempts.userId, input.userId),
        eq(cardCreationAttempts.revision, input.expectedRevision),
        eq(cardCreationAttempts.state, "pending")
      )
    )
    .returning();
  return row === undefined ? null : toRecord(row);
}

export type ConsumeAttemptInput = Readonly<{
  decision: CardCreationDecision;
  expectedRevision: number;
  id: string;
  now: Date;
  userId: string;
}>;

// Consume the review slot: compare-and-set `pending` -> `consumed`, recording the decision, while still at
// the revision the client loaded. Returns whether this caller consumed it. A stale revision or an
// already-consumed attempt misses the set and returns false, so a replayed or racing decision cannot
// re-consume the attempt.
export async function consumeAttempt(
  tx: Transaction,
  input: ConsumeAttemptInput
): Promise<boolean> {
  const consumed = await tx
    .update(cardCreationAttempts)
    .set({
      decision: input.decision,
      state: "consumed",
      revision: input.expectedRevision + 1,
      updatedAt: input.now
    })
    .where(
      and(
        eq(cardCreationAttempts.id, input.id),
        eq(cardCreationAttempts.userId, input.userId),
        eq(cardCreationAttempts.revision, input.expectedRevision),
        eq(cardCreationAttempts.state, "pending")
      )
    )
    .returning({ id: cardCreationAttempts.id });
  return consumed.length > 0;
}

// Discard the owner's PENDING attempt for one submission without recording a decision — used only when a
// save retry finds the previously-matched material has since vanished, so the parked review is moot and the
// card is created directly instead. Fenced to `pending` so a concurrently-decided attempt is never removed.
export async function discardPendingAttempt(
  tx: Transaction,
  userId: string,
  id: string
): Promise<void> {
  await tx
    .delete(cardCreationAttempts)
    .where(
      and(
        eq(cardCreationAttempts.id, id),
        eq(cardCreationAttempts.userId, userId),
        eq(cardCreationAttempts.state, "pending")
      )
    );
}

// Sweep every attempt whose TTL has passed (`expires_at <= now`), pending or consumed: a forgotten review
// never lingers, and a consumed tombstone is not kept past its window. Runs at startup and after each
// attempt operation; adds no scheduler. Accepts any deleter, so a preview can sweep an expired same-request
// attempt inside its own transaction before staging a fresh one (never resurrecting the expired one).
// Returns how many rows were removed.
export async function expireCardCreationAttempts(
  deleter: Pick<DbClient, "delete">,
  now: Date
): Promise<number> {
  const removed = await deleter
    .delete(cardCreationAttempts)
    .where(lte(cardCreationAttempts.expiresAt, now))
    .returning({ id: cardCreationAttempts.id });
  return removed.length;
}
