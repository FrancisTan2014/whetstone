import type { NoteGradingTarget, NotePromptSettingsDto } from "@whetstone/contracts";

import type { SetNoteGradingTargetError } from "../notesReview/notesReviewApi";
import type { SuccessCheckState } from "./RetrievalContractEditor";

// Whether two grading targets describe the same policy: same kind, and for a Success check the same rich
// document. Compared structurally so a re-opened-then-restored Success check is not treated as a change.
// Shared by Card detail (#700) and the in-Review repair view (#691) so both decide "did the trained
// capability change?" identically before offering the Keep-schedule / Restart contract (#686).
export function sameGradingTarget(a: NoteGradingTarget, b: NoteGradingTarget): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "expected_response" && b.kind === "expected_response") {
    return JSON.stringify(a.successCheckDoc) === JSON.stringify(b.successCheckDoc);
  }
  return true;
}

// The Success-check disclosure state a prompt's reveal policy seeds: an `expected_response` reveal opens the
// disclosure on its stored Success check; any other reveal starts closed (grade against the whole note).
export function seedSuccessCheck(reveal: NotePromptSettingsDto["reveal"]): SuccessCheckState {
  return reveal.kind === "expected_response"
    ? { doc: reveal.successCheckDoc, open: true }
    : { open: false };
}

// The failure copy for a settings mutation. A grading-target rejection is named so the learner knows what to
// change; every other failure is the shared retry message. Shared by Card detail and the repair view.
export const gradingFailureMessages: Readonly<Record<SetNoteGradingTargetError["kind"], string>> = {
  invalid_success_check: "Write the success check, or grade against the whole note.",
  legacy_read_only: "This card keeps its original answer and cannot change its grading target.",
  network: "That change could not be saved. The list was refreshed — please try again.",
  not_found: "This card is no longer available. The list was refreshed.",
  restart_requires_card: "Start reviewing this card before restarting its schedule."
};

export const genericGradingFailure =
  "That action could not be completed. The list was refreshed — please try again.";
