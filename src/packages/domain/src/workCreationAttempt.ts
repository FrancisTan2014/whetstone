// The lifecycle of one owner-scoped Work CREATION-REVIEW attempt (#725). Duplicate review is durable
// operational state, not Work identity: an attempt holds the learner's proposed metadata, the reviewed
// duplicate-candidate evidence they were shown, and — for an ordinary upload — the staged bytes, until a
// single serialized decision (Keep separate / Open existing) commits or discards it. An attempt stores NO
// Work, ReadingUnit, Block, or source-claim row; it never becomes content. Source-processing features such
// as the PDF import (#721) keep ownership of their own execution stages — this foundation never absorbs
// `pdf_import_attempts`. This module is pure (no DB, fs, or crypto), so every transition and the evidence
// fingerprint are decided by total functions the store and its consumers can trust.
//
// States:
//   - `pending`    — created; holds proposed metadata, the reviewed candidate snapshot, and any ordinary
//                    upload stage. Awaiting the owner's decision. Non-terminal.
//   - `finalizing` — a serialized decision is in flight: a compare-and-set moved the attempt here so a
//                    second concurrent committer is fenced out while the consumer creates/reopens the Work.
//                    Non-terminal.
//   - `completed`  — the decision committed. Terminal.
//   - `cancelled`  — the owner abandoned the attempt. Terminal.
//   - `expired`    — the attempt outlived its TTL without a decision and was swept. Terminal.

export const workCreationAttemptStates = [
  "pending",
  "finalizing",
  "completed",
  "cancelled",
  "expired"
] as const;

export type WorkCreationAttemptState = (typeof workCreationAttemptStates)[number];

// The terminal outcomes: the review is over and the attempt will never change state again. A terminal
// attempt owns no live decision, so its stage (if any) is leftover cleanup, not input.
const terminalStates: ReadonlySet<WorkCreationAttemptState> = new Set([
  "completed",
  "cancelled",
  "expired"
]);

export function isTerminalWorkCreationAttemptState(state: WorkCreationAttemptState): boolean {
  return terminalStates.has(state);
}

// The non-terminal states (`pending`, `finalizing`) are the exact set an owner may cancel and the TTL
// sweep may expire. The store consults this instead of duplicating the state set, so a new state can
// never be silently treated as terminal.
export function isActiveWorkCreationAttemptState(state: WorkCreationAttemptState): boolean {
  return !terminalStates.has(state);
}

// A serialized decision may BEGIN only from `pending`: the compare-and-set that moves `pending` ->
// `finalizing` is what claims the single decision slot. A `finalizing` row already has a committer, and a
// terminal row is done — so re-issuing the decision against either is rejected as replay, never a no-op.
export function canBeginFinalize(state: WorkCreationAttemptState): boolean {
  return state === "pending";
}

// A decision may COMPLETE only from `finalizing`: completion is the second half of the same serialized
// decision, so it applies only while this attempt still holds the slot the begin-finalize claimed. A
// `pending` row never had the slot; a terminal row already resolved — both reject.
export function canCompleteFinalize(state: WorkCreationAttemptState): boolean {
  return state === "finalizing";
}

// The source that produced an attempt. `manual` carries no uploaded bytes (metadata only, so never an
// exact-source reopen); `markdown`/`epub` are ORDINARY uploads whose staged bytes this attempt owns until
// the decision transfers them to provenance or discards them; `pdf` references its own #721 execution
// attempt, which keeps sole ownership of the PDF stages — a creation attempt never stages PDF bytes.
export const workCreationSourceKinds = ["manual", "markdown", "epub", "pdf"] as const;

export type WorkCreationSourceKind = (typeof workCreationSourceKinds)[number];

// The source kinds whose ordinary uploaded bytes a creation attempt is allowed to own a stage for. Only
// `markdown` and `epub` stage through this foundation; `manual` has no bytes and `pdf` stages through
// `pdf_import_attempts`. The store and the DB check both consult this so a stage can never be bound to an
// attempt that must not own one.
const ordinaryUploadSourceKinds: ReadonlySet<WorkCreationSourceKind> = new Set([
  "markdown",
  "epub"
]);

export function ownsOrdinaryUploadStage(sourceKind: WorkCreationSourceKind): boolean {
  return ordinaryUploadSourceKinds.has(sourceKind);
}

// One reviewed duplicate candidate the learner was shown, captured as EVIDENCE — never a Work reference
// the attempt owns. The snapshot deliberately covers the candidate's identity AND its displayed metadata
// (title, author identity + name, language, type) so that a change to any of them — not only a brand-new
// candidate id — re-fingerprints the set and forces the learner to review again before committing.
export type ReviewedCandidateSnapshotEntry = Readonly<{
  entryId: string;
  title: string;
  authorId: string;
  authorName: string;
  language: string;
  workType: string;
}>;

export type ReviewedCandidateSnapshot = ReadonlyArray<ReviewedCandidateSnapshotEntry>;

// Escape the field/row separators so two distinct snapshots can never serialize to the same fingerprint by
// smuggling a separator into a value (e.g. a title containing a unit-separator character).
function escapeField(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\u001f", "\\u").replaceAll("\u001e", "\\r");
}

// A deterministic fingerprint of the reviewed candidate evidence. Two snapshots fingerprint equal IFF they
// present the same candidates with the same identity AND metadata, regardless of the order they were
// scored in — so the store can detect "the evidence the learner approved has since changed" with a cheap
// string compare and force a fresh review. Pure and total: an empty snapshot (no candidates shown) has a
// stable empty-set fingerprint distinct from every non-empty one.
export function fingerprintReviewedCandidates(snapshot: ReviewedCandidateSnapshot): string {
  const rows = snapshot.map((entry) =>
    [entry.entryId, entry.title, entry.authorId, entry.authorName, entry.language, entry.workType]
      .map(escapeField)
      .join("\u001f")
  );
  // Sort the per-candidate rows so scoring/display order never changes the fingerprint; the candidate id
  // leads each row, so the ordering is stable and total.
  rows.sort();
  return rows.join("\u001e");
}
