import type {
  NotePromptCardStateDto,
  NotePromptRevealPolicyDto,
  NotePromptSettingsDto
} from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";

import { type ReviewCardRow } from "../review/reviewCardQueries.js";

// The prompt fields the Review-settings projection needs: its identity, its editable retrieval question
// (cue), and its persisted reveal policy. A `current_note` prompt carries null answers (its reveal is the
// live note body); a `legacy_custom` prompt carries its own preserved rich answer. Both queries and
// commands build the settings DTO from exactly this shape, so there is one projection.
export type NotePromptProjectionRow = Readonly<{
  entryId: string;
  cueDoc: unknown;
  cueText: string;
  revealKind: "current_note" | "legacy_custom";
  answerDoc: unknown;
  answerText: string | null;
}>;

// Project a prompt's card into the settings state the list shows, discriminated so a row renders on the
// persisted fact. No card → `not_in_review` (offers "Add to review"). A paused card is withheld from the
// due scan. An active card due at/before now is `due`; otherwise it is `scheduled` for its future instant.
export function projectPromptCardState(
  card: ReviewCardRow | undefined,
  now: Date
): NotePromptCardStateDto {
  if (card === undefined) {
    return { state: "not_in_review" };
  }
  if (card.status === "paused") {
    return { state: "paused" };
  }
  if (card.dueAt.getTime() <= now.getTime()) {
    return { state: "due" };
  }
  return { state: "scheduled", nextReviewAt: card.dueAt.toISOString() };
}

// Project a prompt's persisted reveal discriminant into the settings policy DTO. A `current_note` prompt
// declares only its kind — its reveal follows the note's live body, so editing the note edits the reveal
// and the settings row never carries a stale copy. A `legacy_custom` prompt carries its own preserved rich
// answer so the row can render it READ-ONLY (#657: legacy reveals are never editable or converted). The
// answer columns are non-null by construction for a legacy prompt.
export function projectPromptRevealPolicy(row: NotePromptProjectionRow): NotePromptRevealPolicyDto {
  if (row.revealKind === "current_note") {
    return { kind: "current_note" };
  }
  return {
    kind: "legacy_custom",
    answerDoc: row.answerDoc as DocumentNodeJSON,
    answerText: row.answerText as string
  };
}

// Build one Review-settings row: the prompt's identity, its editable question, its reveal policy, and its
// projected card state. Shared by the list query and every settings command's refreshed response, so a
// mutated row and a freshly listed row are always the same shape.
export function projectPromptSettings(
  row: NotePromptProjectionRow,
  card: ReviewCardRow | undefined,
  now: Date
): NotePromptSettingsDto {
  return {
    promptId: row.entryId,
    questionDoc: row.cueDoc as DocumentNodeJSON,
    questionText: row.cueText,
    reveal: projectPromptRevealPolicy(row),
    cardState: projectPromptCardState(card, now)
  };
}
