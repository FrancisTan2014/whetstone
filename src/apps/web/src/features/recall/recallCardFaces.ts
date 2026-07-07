import type { RecallItemDto } from "@whetstone/contracts";

// The two faces of a recall card, derived deterministically from the item (#525). A recall self-grade
// is only meaningful after a retrieval attempt, so the card is a flip: the `front` is the retrieval
// prompt (never reveals the target), the `back` is what to check against after "Show answer".
export type RecallCardFaces = Readonly<{
  // The back's lines, in order. Empty when the item carries no saved answer.
  back: ReadonlyArray<string>;
  // True when there is no back content to reveal (a bare item): the reveal shows a self-check hint,
  // but the item is still gradeable from memory.
  answerless: boolean;
  front: string;
}>;

// A trimmed, non-blank value, or null. Null and whitespace-only fields are both "absent" so a stray
// empty string never becomes a blank face.
function presentText(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return value.trim().length === 0 ? null : value;
}

// Deterministic, production-biased front/back precedence (#525):
// - `cue` present → Front = cue; Back = text + gloss + useContext (the production ideal — you produce
//   the target from the cue, then check it).
// - `cue` absent → Front = text; Back = gloss + useContext (recognition fallback).
// - no back content at all → `answerless` (the reveal shows a self-check hint; still gradeable).
export function recallCardFaces(item: RecallItemDto): RecallCardFaces {
  const cue = presentText(item.cue);
  const gloss = presentText(item.gloss);
  const useContext = presentText(item.useContext);

  const keep = (line: string | null): line is string => line !== null;

  if (cue !== null) {
    const back = [item.text, gloss, useContext].filter(keep);
    return { answerless: back.length === 0, back, front: cue };
  }

  const back = [gloss, useContext].filter(keep);
  return { answerless: back.length === 0, back, front: item.text };
}
