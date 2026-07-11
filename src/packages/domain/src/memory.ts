import type { EntryId } from "./entry.js";
import type { ReviewState } from "./fsrs.js";

// How a Memory note was captured (#595). One shallow, structured enum — deliberately not a tag taxonomy
// (a non-goal) — recording the origin of the durable retention target so later surfaces can filter by it.
export const captureSources = ["manual", "reader", "import", "practice", "tool"] as const;

export type CaptureSource = (typeof captureSources)[number];

const captureSourceSet: ReadonlySet<unknown> = new Set(captureSources);

export function isCaptureSource(value: unknown): value is CaptureSource {
  return captureSourceSet.has(value);
}

// A Memory prompt's lifecycle (#595). A prompt is `scheduled` — carrying a full FSRS card and appearing
// in the due queue — only when it has BOTH a meaningful cue and a meaningful (revealable) answer.
// Otherwise it is a `draft`: a captured retrieval direction with no card yet, never surfaced as a
// "self-check from memory" review. A producer that cannot supply a revealable answer creates a draft.
export const promptLifecycles = ["draft", "scheduled"] as const;

export type PromptLifecycle = (typeof promptLifecycles)[number];

// A cue or answer is "meaningful" when its readable text is non-blank. Whitespace-only content is absent,
// so a stray empty projection never schedules a prompt with nothing to retrieve against.
function isMeaningful(text: string | null): boolean {
  return text !== null && text.trim().length > 0;
}

// A prompt is schedulable only when both cue and answer are meaningful. This is the single gate the
// lifecycle derives from, so "scheduled ⇒ revealable answer" holds by construction.
export function isSchedulablePrompt(cueText: string, answerText: string | null): boolean {
  return isMeaningful(cueText) && isMeaningful(answerText);
}

export function resolvePromptLifecycle(
  cueText: string,
  answerText: string | null
): PromptLifecycle {
  return isSchedulablePrompt(cueText, answerText) ? "scheduled" : "draft";
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
// chunk linkage, its lifecycle, and its FSRS card — which is present iff the prompt is `scheduled`.
export type MemoryPrompt = Readonly<{
  id: EntryId;
  noteId: EntryId;
  cueText: string;
  answerText: string | null;
  chunkId: string | null;
  lifecycle: PromptLifecycle;
  review: ReviewState | null;
}>;

export type BuildMemoryPromptInput = Readonly<{
  id: EntryId;
  noteId: EntryId;
  cueText: string;
  answerText: string | null;
  chunkId?: string | null;
  // The FSRS seed, evaluated only when the prompt is schedulable, so a draft never fabricates a card and
  // a scheduled prompt always carries one. Injected (not computed here) to keep this module free of a
  // clock while still enforcing the draft-vs-scheduled invariant.
  seedReview: () => ReviewState;
}>;

// Build a prompt with its lifecycle and card decided together, enforcing the core invariant in one place:
// a `scheduled` prompt carries a seeded FSRS card and a `draft` prompt carries none. The result is frozen.
export function buildMemoryPrompt(input: BuildMemoryPromptInput): MemoryPrompt {
  const lifecycle = resolvePromptLifecycle(input.cueText, input.answerText);
  return Object.freeze({
    id: input.id,
    noteId: input.noteId,
    cueText: input.cueText,
    answerText: input.answerText,
    chunkId: input.chunkId ?? null,
    lifecycle,
    review: lifecycle === "scheduled" ? input.seedReview() : null
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

// The two faces of a scheduled prompt's review card (#595): the cue is shown first (never revealing the
// answer), and the answer is revealed after the retrieval attempt. A draft has no revealable answer, so
// it has no faces.
export type MemoryPromptFaces = Readonly<{ front: string; back: string }>;

export function memoryPromptFaces(prompt: MemoryPrompt): MemoryPromptFaces | null {
  if (prompt.lifecycle !== "scheduled" || prompt.answerText === null) {
    return null;
  }
  return Object.freeze({ front: prompt.cueText, back: prompt.answerText });
}

// What an edit does to a prompt's FSRS card, kept separate from the card data so the pure decision stays
// clock-free and the caller applies it: `keep` preserves the existing card (content changed but the
// prompt stays scheduled — its review history and schedule must NOT reset), `seed` starts a fresh card
// (a draft became schedulable for the first time), `clear` drops the card (the prompt reverted to a
// draft). The append-only review LOG is never implicated — only the prompt's current card state is.
export type PromptEditReviewAction = "keep" | "seed" | "clear";

export type PromptEditOutcome = Readonly<{
  lifecycle: PromptLifecycle;
  reviewAction: PromptEditReviewAction;
}>;

// Reconcile an edit to a prompt's cue/answer with its schedule, enforcing "editing content never
// silently resets review history": a prompt that stays schedulable keeps its card (`keep`); a draft that
// becomes schedulable seeds one (`seed`); a prompt that is no longer schedulable becomes a draft and
// drops its card (`clear`). The decision depends only on the current lifecycle and the new cue/answer.
export function reconcilePromptEdit(
  currentLifecycle: PromptLifecycle,
  newCueText: string,
  newAnswerText: string | null
): PromptEditOutcome {
  if (isSchedulablePrompt(newCueText, newAnswerText)) {
    return {
      lifecycle: "scheduled",
      reviewAction: currentLifecycle === "scheduled" ? "keep" : "seed"
    };
  }
  return { lifecycle: "draft", reviewAction: "clear" };
}
