import type { NoteRevealDto } from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";

// The minimal facts a reveal is resolved from: the prompt's persisted reveal discriminant and its own
// (nullable) custom answer projections, plus the referenced note's live canonical body. The resolver is
// pure over this input so it tests without a database — the query layer supplies the rows.
export type NoteRevealInput = Readonly<{
  revealKind: "current_note" | "expected_response" | "legacy_custom";
  answerDoc: DocumentNodeJSON | null;
  answerText: string | null;
  noteBodyDoc: DocumentNodeJSON;
  noteBodyText: string;
}>;

// Resolve a prompt's reveal by switching on its PERSISTED discriminant, never on the nullable answer
// columns (#657, #686). `current_note` resolves the note's live canonical body, so a note edit is always
// reflected and note content is never copied onto the prompt. `expected_response` reveals the prompt's
// authored Success check (its stored answer projections) AND the live note as separately labeled
// Reference — the expectation and the canonical note are kept distinct on the wire, never conflated.
// `legacy_custom` resolves the prompt's own preserved custom answer. A ready `expected_response` or
// `legacy_custom` prompt always has both projections (DB `reveal_shape` check), so a missing answer here
// is a data-integrity defect and fails loud rather than revealing an empty answer.
export function resolveNoteReveal(input: NoteRevealInput): NoteRevealDto {
  if (input.revealKind === "current_note") {
    return { kind: "current_note", bodyDoc: input.noteBodyDoc, bodyText: input.noteBodyText };
  }
  if (input.answerDoc === null || input.answerText === null) {
    throw new Error(
      `A ${input.revealKind} prompt must carry both answer projections to reveal (reveal_shape violated).`
    );
  }
  if (input.revealKind === "expected_response") {
    return {
      kind: "expected_response",
      successCheckDoc: input.answerDoc,
      successCheckText: input.answerText,
      referenceDoc: input.noteBodyDoc,
      referenceText: input.noteBodyText
    };
  }
  return { kind: "legacy_custom", answerDoc: input.answerDoc, answerText: input.answerText };
}
