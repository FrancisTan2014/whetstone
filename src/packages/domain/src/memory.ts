import type { EntryId } from "./entry.js";

// How a Memory note was captured (#595). One shallow, structured enum — deliberately not a tag taxonomy
// (a non-goal) — recording the origin of the durable retention target so later surfaces can filter by it.
export const captureSources = ["manual", "reader", "import", "practice", "tool"] as const;

export type CaptureSource = (typeof captureSources)[number];

const captureSourceSet: ReadonlySet<unknown> = new Set(captureSources);

export function isCaptureSource(value: unknown): value is CaptureSource {
  return captureSourceSet.has(value);
}

// A Memory prompt's content-completeness lifecycle (#617). A prompt is `ready` — carrying a revealable
// answer, so it can be enrolled for review — only when it has BOTH a meaningful cue and a meaningful
// answer. Otherwise it is a `draft`: a captured retrieval direction with no reveal, never surfaced as a
// "self-check from memory" review. Readiness is about the prompt's content; whether a ready prompt is
// actually enrolled (has an active review card) is owned by the shared review-card substrate, not here.
export const promptLifecycles = ["draft", "ready"] as const;

export type PromptLifecycle = (typeof promptLifecycles)[number];

// A cue or answer is "meaningful" when its readable text is non-blank. Whitespace-only content is absent,
// so a stray empty projection never marks a prompt ready with nothing to retrieve against.
function isMeaningful(text: string | null): boolean {
  return text !== null && text.trim().length > 0;
}

// A prompt is ready (has a revealable answer) only when both cue and answer are meaningful. This is the
// single gate the lifecycle derives from, so "ready ⇒ revealable answer" holds by construction.
export function isReadyPrompt(cueText: string, answerText: string | null): boolean {
  return isMeaningful(cueText) && isMeaningful(answerText);
}

export function resolvePromptLifecycle(
  cueText: string,
  answerText: string | null
): PromptLifecycle {
  return isReadyPrompt(cueText, answerText) ? "ready" : "draft";
}

// The pure, in-memory shape of a Memory note: identity, its owner, capture source, the readable body
// projection, and optional provenance (the source Entry it was derived from). The canonical rich body
// document is a persistence/transport concern and is not modelled here.
export type MemoryNote = Readonly<{
  id: EntryId;
  userId: string;
  captureSource: CaptureSource;
  bodyText: string;
  derivedFromEntryId: EntryId | null;
}>;

// The pure shape of a Memory prompt: identity, its owning note, the cue/answer projections, optional
// chunk linkage, and its content lifecycle. Scheduling state (the FSRS card) is NOT modelled here — it
// lives in the shared review-card substrate keyed by the prompt's Entry id (#617).
export type MemoryPrompt = Readonly<{
  id: EntryId;
  noteId: EntryId;
  cueText: string;
  answerText: string | null;
  chunkId: string | null;
  lifecycle: PromptLifecycle;
}>;

export type BuildMemoryPromptInput = Readonly<{
  id: EntryId;
  noteId: EntryId;
  cueText: string;
  answerText: string | null;
  chunkId?: string | null;
}>;

// Build a prompt with its content lifecycle decided from its cue/answer: `ready` when both are
// meaningful (a revealable answer exists), `draft` otherwise. The result is frozen. Whether a ready
// prompt gets an active review card is the caller's decision, made through the review-card substrate.
export function buildMemoryPrompt(input: BuildMemoryPromptInput): MemoryPrompt {
  return Object.freeze({
    id: input.id,
    noteId: input.noteId,
    cueText: input.cueText,
    answerText: input.answerText,
    chunkId: input.chunkId ?? null,
    lifecycle: resolvePromptLifecycle(input.cueText, input.answerText)
  });
}

// A prompt is owned by exactly one note; the prompt's owner is transitively its note's owner. This guards
// the identity invariant (the prompt must belong to the given note) so ownership is never resolved across
// an unrelated pair.
export function memoryPromptOwner(note: MemoryNote, prompt: MemoryPrompt): string {
  if (prompt.noteId !== note.id) {
    throw new Error("Prompt does not belong to the given note.");
  }
  return note.userId;
}

// The two faces of a ready prompt's review card (#617): the cue is shown first (never revealing the
// answer), and the answer is revealed after the retrieval attempt. A draft has no revealable answer, so
// it has no faces.
export type MemoryPromptFaces = Readonly<{ front: string; back: string }>;

export function memoryPromptFaces(prompt: MemoryPrompt): MemoryPromptFaces | null {
  if (prompt.lifecycle !== "ready" || prompt.answerText === null) {
    return null;
  }
  return Object.freeze({ front: prompt.cueText, back: prompt.answerText });
}

// What an edit does to a prompt's review card, kept separate from the card data so the pure decision
// stays clock-free and the caller applies it through the review-card substrate: `keep` preserves the
// existing card (content changed but the prompt stays ready — its review schedule must NOT reset),
// `seed` starts a fresh card (a draft became ready for the first time), `clear` drops the card (the
// prompt reverted to a draft). The append-only review EVENT history is never implicated — only the
// prompt's current card is.
export type PromptEditReviewAction = "keep" | "seed" | "clear";

export type PromptEditOutcome = Readonly<{
  lifecycle: PromptLifecycle;
  reviewAction: PromptEditReviewAction;
}>;

// Reconcile an edit to a prompt's cue/answer with its card, enforcing "editing content never silently
// resets review history": a prompt that stays ready keeps its card (`keep`); a draft that becomes ready
// seeds one (`seed`); a prompt that is no longer ready becomes a draft and drops its card (`clear`). The
// decision depends only on the current lifecycle and the new cue/answer.
export function reconcilePromptEdit(
  currentLifecycle: PromptLifecycle,
  newCueText: string,
  newAnswerText: string | null
): PromptEditOutcome {
  if (isReadyPrompt(newCueText, newAnswerText)) {
    return {
      lifecycle: "ready",
      reviewAction: currentLifecycle === "ready" ? "keep" : "seed"
    };
  }
  return { lifecycle: "draft", reviewAction: "clear" };
}
