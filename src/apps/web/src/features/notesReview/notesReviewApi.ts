import {
  parseDirectCardResultDto,
  parseNotePromptSettingsDto,
  parseNotePromptSettingsListDto,
  parseNoteRevealDto,
  parseNoteReviewNextDto,
  parseNoteReviewRatingResultDto,
  parseReviewHistoryPageDto,
  type AuthorNoteCardRequest,
  type CreateDirectCardRequest,
  type DirectCardResultDto,
  type EditNotePromptQuestionRequest,
  type NotePromptSettingsDto,
  type NotePromptSettingsListDto,
  type NoteReviewPromptDto,
  type NoteRevealDto,
  type NoteReviewRatingResultDto,
  type ReviewHistoryPageDto,
  type SetNoteGradingTargetRequest
} from "@whetstone/contracts";
import { type ReviewRating } from "@whetstone/domain";

import { apiUrl } from "../../shared/runtime";

// The Notes-owned Review session keeps its own fetch helper so it stays decoupled from other features.
// Every response is parsed through the shared contracts schema, so a drifted server shape is caught at the
// boundary rather than surfacing as a render-time crash.
const jsonHeaders = { "content-type": "application/json" } as const;

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }
  return response.json();
}

// The single earliest-due prompt (question phase only), or null when nothing is due — the calm
// "due complete" state. Recomputed each call; no queue or cursor is persisted.
export async function fetchNextNotePrompt(): Promise<NoteReviewPromptDto | null> {
  return parseNoteReviewNextDto(await requestJson(apiUrl("/notes/review/next"))).prompt;
}

// Resolve one prompt's reveal — the current canonical note body or the preserved legacy custom answer.
// Fetched only when the learner activates "Show note", so the question phase never carries the answer.
export async function fetchNoteReveal(promptId: string): Promise<NoteRevealDto> {
  return parseNoteRevealDto(
    await requestJson(apiUrl(`/notes/review/prompts/${encodeURIComponent(promptId)}/reveal`))
  );
}

// Rate one prompt: the learner's Again/Hard/Good/Easy rating advances only that prompt's shared card and
// returns its next scheduled state.
export async function rateNotePrompt(
  promptId: string,
  rating: ReviewRating
): Promise<NoteReviewRatingResultDto> {
  return parseNoteReviewRatingResultDto(
    await requestJson(apiUrl(`/notes/review/prompts/${encodeURIComponent(promptId)}/rating`), {
      body: JSON.stringify({ rating }),
      headers: jsonHeaders,
      method: "POST"
    })
  );
}

// The full Review-settings list for one owned note (#660): every prompt in creation order with its reveal
// policy and projected card state. A read; it changes nothing.
export async function fetchNotePromptSettings(
  noteEntryId: string
): Promise<NotePromptSettingsListDto> {
  return parseNotePromptSettingsListDto(
    await requestJson(apiUrl(`/notes/${encodeURIComponent(noteEntryId)}/review/settings`))
  );
}

// One page of a prompt's append-only Review history (#660), newest first. The opaque `cursor` (from a
// previous page's `nextCursor`) loads older events; omit it for the first page. A read; it changes nothing.
export async function fetchNotePromptHistory(
  promptId: string,
  cursor?: string
): Promise<ReviewHistoryPageDto> {
  const base = apiUrl(`/notes/review/prompts/${encodeURIComponent(promptId)}/history`);
  const path = cursor === undefined ? base : `${base}?cursor=${encodeURIComponent(cursor)}`;
  return parseReviewHistoryPageDto(await requestJson(path));
}

// Edit one prompt's retrieval question (#660, rich in #687): sends the rich Question document plus the
// settings revision the editor loaded and returns the incremented row. The server derives plaintext,
// rejects a blank document, and answers `prompt_conflict` instead of overwriting a newer prompt revision.
export async function editNotePromptQuestion(
  promptId: string,
  request: EditNotePromptQuestionRequest
): Promise<NotePromptSettingsDto> {
  let response: Response;
  try {
    response = await fetch(
      apiUrl(`/notes/review/prompts/${encodeURIComponent(promptId)}/question`),
      { body: JSON.stringify(request), headers: jsonHeaders, method: "PATCH" }
    );
  } catch {
    throw new EditNotePromptQuestionError("network");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    if (response.status === 400 && body?.error === "invalid_question") {
      throw new EditNotePromptQuestionError("invalid_question");
    }
    if (response.status === 404) {
      throw new EditNotePromptQuestionError("not_found");
    }
    if (response.status === 409 && body?.error === "prompt_conflict") {
      throw new EditNotePromptQuestionError("conflict");
    }
    throw new EditNotePromptQuestionError("network");
  }
  return parseNotePromptSettingsDto(await response.json());
}

export type EditNotePromptQuestionErrorKind =
  | "conflict"
  | "invalid_question"
  | "network"
  | "not_found";

export class EditNotePromptQuestionError extends Error {
  readonly kind: EditNotePromptQuestionErrorKind;

  constructor(kind: EditNotePromptQuestionErrorKind) {
    super(`Editing the Question failed: ${kind}.`);
    this.name = "EditNotePromptQuestionError";
    this.kind = kind;
  }
}

// Why setting a prompt's grading target failed (#686), kept as a small closed set so Card detail can report
// the exact reason and keep the learner's drafts. `invalid_success_check` is a blank Success check;
// `legacy_read_only` rejects converting a preserved `legacy_custom` prompt; `restart_requires_card` rejects
// a `restart` on a cardless prompt; `not_found` is a prompt that is no longer the learner's; `network` is a
// lost response, retry-safe with the same intent.
export type SetNoteGradingTargetErrorKind =
  | "conflict"
  | "invalid_success_check"
  | "legacy_read_only"
  | "network"
  | "not_found"
  | "restart_requires_card";

export class SetNoteGradingTargetError extends Error {
  readonly kind: SetNoteGradingTargetErrorKind;

  constructor(kind: SetNoteGradingTargetErrorKind) {
    super(`Setting the grading target failed: ${kind}.`);
    this.name = "SetNoteGradingTargetError";
    this.kind = kind;
  }
}

// Set one prompt's grading target (#686): `mode` explicitly chooses `keep` (save the policy, never touch the
// schedule) or `restart` (also reset the schedule, due now) so Whetstone never infers whether the trained
// capability changed. Returns the refreshed settings row. On failure this throws a
// `SetNoteGradingTargetError` whose `kind` maps the server outcome by status and error body — 400
// `invalid_success_check`, 404 `not_found`, 409 `legacy_read_only`/`restart_requires_card`/
// `prompt_conflict`, anything else `network` — so Card detail keeps every draft and reports the right reason.
export async function setNoteGradingTarget(
  promptId: string,
  request: SetNoteGradingTargetRequest
): Promise<NotePromptSettingsDto> {
  let response: Response;
  try {
    response = await fetch(
      apiUrl(`/notes/review/prompts/${encodeURIComponent(promptId)}/grading-target`),
      { body: JSON.stringify(request), headers: jsonHeaders, method: "POST" }
    );
  } catch {
    throw new SetNoteGradingTargetError("network");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    if (response.status === 400 && body?.error === "invalid_success_check") {
      throw new SetNoteGradingTargetError("invalid_success_check");
    }
    if (response.status === 404) {
      throw new SetNoteGradingTargetError("not_found");
    }
    if (response.status === 409 && body?.error === "legacy_read_only") {
      throw new SetNoteGradingTargetError("legacy_read_only");
    }
    if (response.status === 409 && body?.error === "restart_requires_card") {
      throw new SetNoteGradingTargetError("restart_requires_card");
    }
    if (response.status === 409 && body?.error === "prompt_conflict") {
      throw new SetNoteGradingTargetError("conflict");
    }
    throw new SetNoteGradingTargetError("network");
  }
  return parseNotePromptSettingsDto(await response.json());
}

// Apply a card transition to one prompt through its settings route (#660): pause, resume, restart, or
// re-add (POST) and remove (DELETE). Each returns the prompt's refreshed settings row so the caller updates
// exactly that row. The target is fully addressed by the URL, so no body is sent.
async function mutateNotePromptCard(
  promptId: string,
  action: "pause" | "resume" | "restart" | "card",
  method: "POST" | "DELETE"
): Promise<NotePromptSettingsDto> {
  return parseNotePromptSettingsDto(
    await requestJson(apiUrl(`/notes/review/prompts/${encodeURIComponent(promptId)}/${action}`), {
      method
    })
  );
}

export function pauseNotePromptCard(promptId: string): Promise<NotePromptSettingsDto> {
  return mutateNotePromptCard(promptId, "pause", "POST");
}

export function resumeNotePromptCard(promptId: string): Promise<NotePromptSettingsDto> {
  return mutateNotePromptCard(promptId, "resume", "POST");
}

export function restartNotePromptCard(promptId: string): Promise<NotePromptSettingsDto> {
  return mutateNotePromptCard(promptId, "restart", "POST");
}

export function addNotePromptCardBack(promptId: string): Promise<NotePromptSettingsDto> {
  return mutateNotePromptCard(promptId, "card", "POST");
}

export function removeNotePromptCard(promptId: string): Promise<NotePromptSettingsDto> {
  return mutateNotePromptCard(promptId, "card", "DELETE");
}

// Why a direct card creation failed, kept as a small closed set so the composer can decide whether a retry
// is worthwhile (a `network` blip is recoverable with the SAME submission id) or the drafts must change (a
// `conflict` is the same id replayed with an edited payload; `gone` is a tombstoned submission whose note
// was deleted). Every case keeps the learner's drafts — the composer never blanks them on failure.
export type CreateDirectCardErrorKind = "conflict" | "gone" | "invalid" | "network";

export class CreateDirectCardError extends Error {
  readonly kind: CreateDirectCardErrorKind;

  constructor(kind: CreateDirectCardErrorKind) {
    super(`Direct card creation failed: ${kind}.`);
    this.name = "CreateDirectCardError";
    this.kind = kind;
  }
}

// Create one review card directly from an authored Question/Answer pair (#689, #690), retry-safe via the
// composer's stable `submissionId`. A same-payload retry returns the ORIGINAL result (200), so a lost
// response never double-creates. On failure this throws a `CreateDirectCardError` whose `kind` maps the
// server outcome — 409 → `conflict`, 410 → `gone`, 4xx → `invalid`, anything else → `network` — so the
// composer keeps every draft and offers the right recovery.
export async function createDirectCard(
  request: CreateDirectCardRequest
): Promise<DirectCardResultDto> {
  let response: Response;
  try {
    response = await fetch(apiUrl("/notes/review/direct-cards"), {
      body: JSON.stringify(request),
      headers: jsonHeaders,
      method: "POST"
    });
  } catch {
    throw new CreateDirectCardError("network");
  }
  if (!response.ok) {
    if (response.status === 409) {
      throw new CreateDirectCardError("conflict");
    }
    if (response.status === 410) {
      throw new CreateDirectCardError("gone");
    }
    if (response.status >= 400 && response.status < 500) {
      throw new CreateDirectCardError("invalid");
    }
    throw new CreateDirectCardError("network");
  }
  return parseDirectCardResultDto(await response.json());
}

// Why authoring a card over an existing saved note failed (#687; independent directions in #688), kept as a
// small closed set so the composer can decide recovery. A `network` blip is recoverable with the SAME
// submission id; a `conflict` is the same id replayed with an edited payload; `gone` is a tombstoned
// submission whose note was deleted; `not_found` means the note no longer belongs to the learner. Every case
// keeps the learner's drafts.
export type AuthorNoteCardErrorKind = "conflict" | "gone" | "invalid" | "network" | "not_found";

export class AuthorNoteCardError extends Error {
  readonly kind: AuthorNoteCardErrorKind;

  constructor(kind: AuthorNoteCardErrorKind) {
    super(`Authoring a note card failed: ${kind}.`);
    this.name = "AuthorNoteCardError";
    this.kind = kind;
  }
}

// Author a review card over an EXISTING saved note (#687; independent directions in #688), retry-safe via
// the composer's stable `submissionId`. A same-payload retry returns the ORIGINAL result (200), so a lost
// response never double-creates, while a DIFFERENT submission always creates a new card. On failure this
// throws an `AuthorNoteCardError` whose `kind` maps the server outcome — 409 → `conflict`, 410 → `gone`,
// 404 → `not_found`, other 4xx → `invalid`, anything else → `network` — so the composer keeps every draft
// and offers the right recovery.
export async function authorNoteCard(request: AuthorNoteCardRequest): Promise<DirectCardResultDto> {
  let response: Response;
  try {
    response = await fetch(apiUrl("/notes/review/author-cards"), {
      body: JSON.stringify(request),
      headers: jsonHeaders,
      method: "POST"
    });
  } catch {
    throw new AuthorNoteCardError("network");
  }
  if (!response.ok) {
    if (response.status === 409) {
      throw new AuthorNoteCardError("conflict");
    }
    if (response.status === 410) {
      throw new AuthorNoteCardError("gone");
    }
    if (response.status === 404) {
      throw new AuthorNoteCardError("not_found");
    }
    if (response.status >= 400 && response.status < 500) {
      throw new AuthorNoteCardError("invalid");
    }
    throw new AuthorNoteCardError("network");
  }
  return parseDirectCardResultDto(await response.json());
}
