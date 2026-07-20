import type { NoteGradingTarget } from "@whetstone/contracts";
import { type DocumentNodeJSON, documentText } from "@whetstone/document";

// The persisted answer columns a grading target resolves to (#686): a `current_note` target stores no
// answer (its reveal is the live note body); an `expected_response` target stores the authored Success
// check as both a rich doc and its server-derived plaintext. Deriving the text here (never trusting the
// client) is also the non-blank gate — a Success check that renders to only whitespace is rejected as
// `invalid_success_check`. This is the single reveal-column policy: both the Review-settings grading-target
// command (#686) and the retry-safe direct card command (#689) resolve their prompt's reveal columns
// through it, so a prompt's shape is decided in exactly one place.
export type ResolvedGradingColumns =
  | Readonly<{ status: "ok"; revealKind: "current_note"; answerDoc: null; answerText: null }>
  | Readonly<{
      status: "ok";
      revealKind: "expected_response";
      answerDoc: DocumentNodeJSON;
      answerText: string;
    }>
  | Readonly<{ status: "invalid_success_check" }>;

export function resolveGradingColumns(target: NoteGradingTarget): ResolvedGradingColumns {
  if (target.kind === "current_note") {
    return { status: "ok", revealKind: "current_note", answerDoc: null, answerText: null };
  }
  const answerText = documentText(target.successCheckDoc);
  if (answerText.trim().length === 0) {
    return { status: "invalid_success_check" };
  }
  return {
    status: "ok",
    revealKind: "expected_response",
    answerDoc: target.successCheckDoc,
    answerText
  };
}
