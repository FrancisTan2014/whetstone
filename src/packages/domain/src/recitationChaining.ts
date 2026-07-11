// Maintaining recitation through contiguous chaining (#580): the pure logic that grows passage practice
// (#578, #579) from isolated passages into reliable transitions and eventually whole-work upkeep. Given
// each passage's mastery signal (successful reviews + current FSRS state) this decides which passages
// the learner truly *owns*, how far the owned span reaches contiguously from the Work's beginning,
// whether a chain session or whole-work maintenance may be offered, which single recitation action Today
// should surface, and — after a chain/whole-work reveal — exactly which passage a targeted lapse fails.
// No persistence, scheduling maths, DB, network, or UI here: time enters only via a passed-in `now`, and
// FSRS retrievability is read through the domain scheduler boundary.

import { RECALL_REQUEST_RETENTION, retrievability, type ReviewState } from "./fsrs.js";

// A passage counts as *owned* only after at least this many clean recalls. Two successful (Good/Easy)
// reviews is the deterministic floor from #580 — one lucky recall is not ownership.
export const OWNERSHIP_MIN_SUCCESSFUL_REVIEWS = 2;

// The retention target a passage's current retrievability must meet to still count as owned. Reuses the
// single v0 scheduler retention so "owned" and "scheduled as known" agree; ownership therefore decays
// with time (a long-unpractised passage drops out of the owned prefix) rather than being permanent.
export const OWNERSHIP_RETENTION_TARGET = RECALL_REQUEST_RETENTION;

// The smallest chain worth practising: two adjacent owned passages, so the transition between them is
// what gets rehearsed. A single owned passage is just an ordinary due review, not a chain.
export const MIN_CHAIN_LENGTH = 2;

// One passage's ownership signal in source order: its addressable id, how many successful (Good/Easy)
// self-assessments it has recorded, and its current FSRS card. The caller supplies passages already in
// reciting order (orderIndex ascending); this module never reorders them.
export type PassageMastery = Readonly<{
  passageEntryId: string;
  successfulReviews: number;
  state: ReviewState;
}>;

// A passage is owned when the learner has recalled it cleanly enough *and* still retains it now: at
// least two successful reviews, and current retrievability at or above the retention target. The
// retrievability check makes ownership a live property (it lapses as memory fades), not a one-time badge.
export function isPassageOwned(passage: PassageMastery, now: Date): boolean {
  return (
    passage.successfulReviews >= OWNERSHIP_MIN_SUCCESSFUL_REVIEWS &&
    retrievability(passage.state, now) >= OWNERSHIP_RETENTION_TARGET
  );
}

// The owned prefix: how many passages, counted contiguously from the Work's beginning, are currently
// owned. The count stops at the first non-owned passage, so a later island of owned passages does not
// inflate progress (#580: never present disconnected mastery as equivalent progress). `total` is the
// passage count, so a caller can show "ownedCount of total" without treating gaps as done.
export type OwnedPrefix = Readonly<{ ownedCount: number; total: number }>;

export function computeOwnedPrefix(passages: readonly PassageMastery[], now: Date): OwnedPrefix {
  let ownedCount = 0;
  for (const passage of passages) {
    if (!isPassageOwned(passage, now)) {
      break;
    }
    ownedCount += 1;
  }
  return { ownedCount, total: passages.length };
}

// Whether the learner owns the entire Work — every passage owned, with at least one passage — so
// whole-work maintenance may be offered. Derived from the owned prefix so it uses the same contiguous,
// live-retrievability rule (an unpractised passage anywhere disqualifies the whole work).
export function isWholeWorkOwned(passages: readonly PassageMastery[], now: Date): boolean {
  const { ownedCount, total } = computeOwnedPrefix(passages, now);
  return total > 0 && ownedCount === total;
}

// Whether a contiguous chain session may be offered, and if so the furthest end boundary the learner may
// choose. A chain always starts at the Work's first passage and runs contiguously; the learner picks the
// end within the owned prefix, and no passage inside may be skipped. `maxEndIndex` is the last selectable
// 0-based passage index (the owned prefix's final passage).
export type ChainEligibility =
  | Readonly<{ status: "eligible"; maxEndIndex: number }>
  | Readonly<{ status: "not_eligible" }>;

export function chainEligibility(passages: readonly PassageMastery[], now: Date): ChainEligibility {
  const { ownedCount } = computeOwnedPrefix(passages, now);
  if (ownedCount < MIN_CHAIN_LENGTH) {
    return { status: "not_eligible" };
  }
  return { maxEndIndex: ownedCount - 1, status: "eligible" };
}

export type ChainBoundaryInvalidReason = "too_short" | "out_of_range" | "not_owned";

// The result of resolving a learner-chosen chain end boundary against the current owned prefix. A valid
// chain is the contiguous run of passages [0..endIndex] — all owned, in fixed source order, none skipped
// — returned as their ids so the caller can persist/render the exact sequence.
export type ChainBoundaryResult =
  | Readonly<{ status: "ok"; passageEntryIds: readonly string[] }>
  | Readonly<{ status: "invalid"; reason: ChainBoundaryInvalidReason }>;

// Resolve a requested chain end boundary (0-based passage index). Rejected when it would make a chain
// shorter than two passages, points past the last passage, or reaches beyond the owned prefix (a chain
// may only include owned passages). Otherwise returns the ordered passage ids of the whole [0..endIndex]
// run, guaranteeing contiguity and fixed order with nothing skipped.
export function resolveChainBoundary(
  passages: readonly PassageMastery[],
  now: Date,
  endIndex: number
): ChainBoundaryResult {
  if (!Number.isInteger(endIndex) || endIndex < MIN_CHAIN_LENGTH - 1) {
    return { reason: "too_short", status: "invalid" };
  }
  if (endIndex >= passages.length) {
    return { reason: "out_of_range", status: "invalid" };
  }
  const { ownedCount } = computeOwnedPrefix(passages, now);
  if (endIndex > ownedCount - 1) {
    return { reason: "not_owned", status: "invalid" };
  }
  return {
    passageEntryIds: passages.slice(0, endIndex + 1).map((passage) => passage.passageEntryId),
    status: "ok"
  };
}

// The single recitation action Today may surface, in strict priority order (#580): a due passage first,
// then an active chain, then whole-work maintenance, then nothing. Today shows at most one, so the
// engine never becomes an overdue wall.
export const recitationTodayActions = ["due_passage", "chain", "whole_work", "none"] as const;

export type RecitationTodayAction = (typeof recitationTodayActions)[number];

// Select Today's one recitation action from what is available, applying the fixed priority. The caller
// supplies only booleans (already resolved from due dates / active chains), so this stays pure and is
// the single place the priority is expressed.
export function selectRecitationTodayAction(
  available: Readonly<{ hasDuePassage: boolean; hasActiveChain: boolean; wholeWorkDue: boolean }>
): RecitationTodayAction {
  if (available.hasDuePassage) {
    return "due_passage";
  }
  if (available.hasActiveChain) {
    return "chain";
  }
  if (available.wholeWorkDue) {
    return "whole_work";
  }
  return "none";
}

// The outcome of a chain or whole-work reveal: recall either held throughout, or it broke at one
// passage the learner explicitly identified. Nothing is inferred — an un-identified passage is never
// silently failed, and a clean run rates nothing (that is what avoids a wall of duplicate reviews).
export type SessionRecallOutcome =
  | Readonly<{ status: "held" }>
  | Readonly<{ status: "broke"; passageEntryId: string }>;

// Which passages receive an Again from a chain/whole-work reveal: exactly the one the learner identified
// as broken, and never any other. A held run fails nothing. This is the whole targeted-lapse rule —
// #580's "only an explicitly identified passage receives an Again rating."
export function passagesToFailFromOutcome(outcome: SessionRecallOutcome): readonly string[] {
  return outcome.status === "broke" ? [outcome.passageEntryId] : [];
}

// Validate that a learner-identified broken passage actually belongs to the session it was reported
// against — a chain's ordered passage ids, or a whole-work session's full passage set. Guards the
// server from applying a targeted Again to a passage outside the reviewed sequence (a forged or stale
// id). A held outcome is always valid.
export function isOutcomePassageInSession(
  outcome: SessionRecallOutcome,
  sessionPassageEntryIds: readonly string[]
): boolean {
  return outcome.status === "held" || sessionPassageEntryIds.includes(outcome.passageEntryId);
}
