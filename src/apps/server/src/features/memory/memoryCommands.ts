import type {
  AddMemoryPromptRequest,
  DepositMemoryRequest,
  EditMemoryPromptRequest,
  MemoryDepositDto,
  MemoryNoteDetailDto,
  MemoryPromptDto
} from "@whetstone/contracts";
import {
  applyRating,
  buildMemoryPrompt,
  newReviewState,
  reconcilePromptEdit,
  toEntryId,
  type CaptureSource,
  type EntryId,
  type ReviewRating,
  type ReviewState
} from "@whetstone/domain";
import { createTextDocument } from "@whetstone/document";
import { eq, inArray, or } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import {
  entries,
  entryLinks,
  memoryNotes,
  memoryPromptReviews,
  memoryPrompts,
  personalEntries
} from "../../db/schema.js";
import {
  getMemoryNoteDetail,
  getMemoryNoteRowForUser,
  getPromptRowForUser,
  getScheduledPromptByChunkForUser,
  promptReviewColumns,
  promptReviewStateOrNull,
  scheduledPromptReviewState,
  toMemoryDepositDto,
  toMemoryPromptDto,
  type MemoryNoteRow,
  type MemoryPromptRow
} from "./memoryQueries.js";

// Real infrastructure boundaries (the database client, id generation) are injected so the commands stay
// deterministic and testable; `now` is passed in explicitly (and feeds the pure FSRS scheduler).
export type MemoryDependencies = Readonly<{
  createId: () => string;
  db: DbClient;
  // Offline answer suggestion (#526/#595): resolve a short back for a prompt's `glossTerm` from the
  // bundled offline dictionaries so a producer with only a target can still schedule the prompt. It never
  // blocks the write — an unknown term (or an absent glosser) leaves the answer null and the prompt is
  // saved as an unscheduled draft. Optional because producers that always supply an answer (e.g. chunk
  // practice) need not wire it.
  resolveOfflineGloss?: (text: string) => Promise<string | null>;
}>;

export type RecordPromptReviewResult =
  | Readonly<{ prompt: MemoryPromptDto; status: "recorded" }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "not_scheduled" }>;

export type SnoozePromptResult =
  | Readonly<{ prompt: MemoryPromptDto; status: "snoozed" }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "not_scheduled" }>;

// Editing a note's body or adding a direction returns the refreshed detail; a missing/non-owned note is
// `not_found`. Editing a single prompt returns the updated prompt DTO.
export type EditMemoryNoteResult =
  | Readonly<{ detail: MemoryNoteDetailDto; status: "updated" }>
  | Readonly<{ status: "not_found" }>;

export type EditMemoryPromptResult =
  | Readonly<{ prompt: MemoryPromptDto; status: "updated" }>
  | Readonly<{ status: "not_found" }>;

export type AddMemoryPromptResult =
  | Readonly<{ detail: MemoryNoteDetailDto; status: "added" }>
  | Readonly<{ status: "not_found" }>;

export type DeleteMemoryNoteResult =
  | Readonly<{ status: "deleted" }>
  | Readonly<{ status: "not_found" }>;

// How far a snooze defers a prompt: one day, so it leaves today's batch and reappears tomorrow.
const SNOOZE_DEFER_DAYS = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// One retrieval prompt to persist under a note, after the answer has been resolved.
type ResolvedPrompt = Readonly<{
  id: EntryId;
  cueText: string;
  answerText: string | null;
  chunkId: string | null;
}>;

// Resolve a prompt's answer: a supplied answer always wins; otherwise, if a `glossTerm` is present and an
// offline glosser is wired, suggest a back from the bundled dictionaries (#526). The glosser fails soft to
// null, so an unknown term leaves the answer null and the prompt is saved as a draft — capture is never
// blocked.
async function resolveAnswer(
  dependencies: MemoryDependencies,
  prompt: DepositMemoryRequest["prompts"][number]
): Promise<string | null> {
  const supplied = prompt.answerText ?? null;
  if (
    supplied !== null ||
    prompt.glossTerm === undefined ||
    prompt.glossTerm === null ||
    dependencies.resolveOfflineGloss === undefined
  ) {
    return supplied;
  }
  return dependencies.resolveOfflineGloss(prompt.glossTerm);
}

// Deposit a Memory: one note (the durable retention target) and one-or-more retrieval prompts, atomically.
// The note is a first-class owned Entry (its `personal_entries` facet carries ownership + chronology, like
// notes/diary); provenance is a `derived_from` link, not a column; each prompt is a child Entry linked to
// the note by `contains`, scheduled iff it has both a meaningful cue and a revealable answer.
// The transaction handle drizzle passes into `db.transaction`, so a shared write helper can run inside a
// caller's transaction.
type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// Atomically insert a memory note (its Entry + ownership facet + row), its optional `derived_from`
// provenance link, and each prompt (Entry + row + `contains` link). Shared by every deposit path so the
// note/prompt/link wiring lives in one place.
async function writeMemory(
  tx: Transaction,
  params: Readonly<{
    noteRow: MemoryNoteRow;
    derivedFromEntryId: string | null;
    promptRows: ReadonlyArray<MemoryPromptRow>;
    userId: string;
    now: Date;
  }>
): Promise<void> {
  const { noteRow, derivedFromEntryId, promptRows, userId, now } = params;
  await tx.insert(entries).values({ id: noteRow.entryId, type: "memory_note" });
  await tx.insert(personalEntries).values({
    createdAt: now,
    entryId: noteRow.entryId,
    occurredAt: now,
    updatedAt: now,
    userId
  });
  await tx.insert(memoryNotes).values(noteRow);
  if (derivedFromEntryId !== null) {
    await tx.insert(entryLinks).values({
      fromEntryId: noteRow.entryId,
      toEntryId: derivedFromEntryId,
      type: "derived_from"
    });
  }
  for (const promptRow of promptRows) {
    await tx.insert(entries).values({ id: promptRow.entryId, type: "memory_prompt" });
    await tx.insert(memoryPrompts).values(promptRow);
    await tx.insert(entryLinks).values({
      fromEntryId: noteRow.entryId,
      toEntryId: promptRow.entryId,
      type: "contains"
    });
  }
}

export async function depositMemory(
  dependencies: MemoryDependencies,
  request: DepositMemoryRequest,
  userId: string,
  now: Date
): Promise<MemoryDepositDto> {
  const prepared = await prepareDeposit(dependencies, request, now);

  await dependencies.db.transaction((tx) => writeMemory(tx, { ...prepared, userId, now }));

  return toMemoryDepositDto(prepared.noteRow, prepared.derivedFromEntryId, prepared.promptRows);
}

// A single deposit resolved into the exact rows to persist, with all async answer resolution already done.
// Separating preparation from the write lets the batch importer resolve every item's answers (which may
// call the offline glosser) up front and then commit the whole batch inside one transaction.
type PreparedDeposit = Readonly<{
  noteRow: MemoryNoteRow;
  derivedFromEntryId: string | null;
  promptRows: ReadonlyArray<MemoryPromptRow>;
}>;

async function prepareDeposit(
  dependencies: MemoryDependencies,
  request: DepositMemoryRequest,
  now: Date
): Promise<PreparedDeposit> {
  const noteId = toEntryId(dependencies.createId());
  const derivedFromEntryId = request.derivedFromEntryId ?? null;

  const resolvedPrompts: ResolvedPrompt[] = [];
  for (const prompt of request.prompts) {
    resolvedPrompts.push({
      id: toEntryId(dependencies.createId()),
      cueText: prompt.cueText,
      answerText: await resolveAnswer(dependencies, prompt),
      chunkId: prompt.chunkId ?? null
    });
  }

  const noteRow: MemoryNoteRow = {
    entryId: noteId,
    bodyDoc: createTextDocument(request.noteText),
    bodyText: request.noteText,
    captureSource: request.captureSource
  };

  const promptRows = resolvedPrompts.map((prompt) => buildPromptRow(prompt, noteId, now));
  return { noteRow, derivedFromEntryId, promptRows };
}

// Import a batch of pasted notebook drafts (#574) as Memory notes in one atomic write. Every item's
// answers are resolved first (the offline glosser may run per prompt), then the whole batch is committed
// inside a single transaction: either every note lands or none does, so a failed import never leaves a
// partial or duplicated batch behind and the client can safely keep the untouched paste. The imported
// notes flow into Memory and Timeline through their Entries — there is no batch-specific history row.
export async function importMemoryBatch(
  dependencies: MemoryDependencies,
  items: ReadonlyArray<DepositMemoryRequest>,
  userId: string,
  now: Date
): Promise<ReadonlyArray<MemoryDepositDto>> {
  const prepared: PreparedDeposit[] = [];
  for (const item of items) {
    prepared.push(await prepareDeposit(dependencies, item, now));
  }

  await dependencies.db.transaction(async (tx) => {
    for (const deposit of prepared) {
      await writeMemory(tx, { ...deposit, userId, now });
    }
  });

  return prepared.map((deposit) =>
    toMemoryDepositDto(deposit.noteRow, deposit.derivedFromEntryId, deposit.promptRows)
  );
}

// One prompt to deposit under a fresh single-prompt memory, before its answer is resolved.
type SinglePromptInput = Readonly<{
  cueText: string;
  answerText: string | null;
  chunkId: string | null;
  glossTerm: string | null;
  captureSource: CaptureSource;
  noteText: string;
  derivedFromEntryId: string | null;
}>;

// Deposit a memory holding exactly one prompt and return the created note id and the single prompt row —
// without any array indexing at the call site. The prompt's lifecycle follows the same rule as
// `depositMemory` (scheduled iff cue and answer are both meaningful, else draft). Shared by the session
// deposit paths (chunk practice and pushed-phrase capture).
async function depositSinglePromptMemory(
  dependencies: MemoryDependencies,
  input: SinglePromptInput,
  userId: string,
  now: Date
): Promise<Readonly<{ noteId: EntryId; promptRow: MemoryPromptRow }>> {
  const noteId = toEntryId(dependencies.createId());
  const answerText = await resolveAnswer(dependencies, {
    cueText: input.cueText,
    ...(input.answerText === null ? {} : { answerText: input.answerText }),
    ...(input.chunkId === null ? {} : { chunkId: input.chunkId }),
    ...(input.glossTerm === null ? {} : { glossTerm: input.glossTerm })
  });
  const noteRow: MemoryNoteRow = {
    entryId: noteId,
    bodyDoc: createTextDocument(input.noteText),
    bodyText: input.noteText,
    captureSource: input.captureSource
  };
  const promptRow = buildPromptRow(
    {
      id: toEntryId(dependencies.createId()),
      cueText: input.cueText,
      answerText,
      chunkId: input.chunkId
    },
    noteId,
    now
  );

  await dependencies.db.transaction((tx) =>
    writeMemory(tx, {
      noteRow,
      derivedFromEntryId: input.derivedFromEntryId,
      promptRows: [promptRow],
      userId,
      now
    })
  );

  return { noteId, promptRow };
}

// A chunk practice deposit + review: the situation cues the target (always schedulable), deduped by
// chunk so repeated practice keeps one prompt. Returns the prompt id and its next due date (the pure FSRS
// advance, deterministic under seeded fuzz). Used by the session's per-turn and debrief chunk deposits.
export async function reviewChunkMemory(
  dependencies: MemoryDependencies,
  params: Readonly<{
    userId: string;
    chunkId: string;
    situation: string;
    target: string;
    sourceBlockEntryId: string | null;
  }>,
  rating: ReviewRating,
  now: Date
): Promise<Readonly<{ promptId: string; nextDueAt: Date }>> {
  const { userId, chunkId, situation, target, sourceBlockEntryId } = params;
  const existing = await getScheduledPromptByChunkForUser(dependencies.db, userId, chunkId);

  let promptId: string;
  let currentState: ReviewState;
  if (existing === undefined) {
    const { promptRow } = await depositSinglePromptMemory(
      dependencies,
      {
        cueText: situation,
        answerText: target,
        chunkId,
        glossTerm: null,
        captureSource: "practice",
        noteText: target,
        derivedFromEntryId: sourceBlockEntryId
      },
      userId,
      now
    );
    promptId = promptRow.entryId;
    currentState = scheduledPromptReviewState(promptRow);
  } else {
    promptId = existing.entryId;
    currentState = scheduledPromptReviewState(existing);
  }

  const nextDueAt = applyRating(currentState, rating, now).due;
  await recordPromptReview(dependencies, promptId, rating, userId, now);
  return { promptId, nextDueAt: new Date(nextDueAt) };
}

// A pushed-phrase deposit (#270/#595): the coach's English target becomes a prompt cued by itself, with
// its answer suggested from the offline dictionary via `glossTerm`. When no gloss is found the prompt is
// saved as an unscheduled draft (review null), so the caller does not surface it as due. Returns the
// created prompt (its review is null for a draft, the seeded card for a scheduled prompt).
export async function depositPushedPhrase(
  dependencies: MemoryDependencies,
  params: Readonly<{ userId: string; target: string }>,
  now: Date
): Promise<MemoryPromptDto> {
  const { promptRow } = await depositSinglePromptMemory(
    dependencies,
    {
      cueText: params.target,
      answerText: null,
      chunkId: null,
      glossTerm: params.target,
      captureSource: "practice",
      noteText: params.target,
      derivedFromEntryId: null
    },
    params.userId,
    now
  );
  return toMemoryPromptDto(promptRow);
}

// Build the persisted prompt row, deciding lifecycle + FSRS card together via the domain invariant: a
// scheduled prompt (meaningful cue AND answer) carries a seeded card and its columns; a draft carries
// none (all FSRS columns and the rich answer doc stay null).
function buildPromptRow(prompt: ResolvedPrompt, noteId: EntryId, now: Date): MemoryPromptRow {
  const built = buildMemoryPrompt({
    id: prompt.id,
    noteId,
    cueText: prompt.cueText,
    answerText: prompt.answerText,
    chunkId: prompt.chunkId,
    seedReview: () => newReviewState(now)
  });
  const base = {
    entryId: prompt.id,
    noteEntryId: noteId,
    cueDoc: createTextDocument(prompt.cueText),
    cueText: prompt.cueText,
    answerDoc: prompt.answerText === null ? null : createTextDocument(prompt.answerText),
    answerText: prompt.answerText,
    lifecycle: built.lifecycle,
    chunkId: prompt.chunkId,
    createdAt: now
  };
  if (built.review === null) {
    return {
      ...base,
      stability: null,
      difficulty: null,
      elapsedDays: null,
      scheduledDays: null,
      learningSteps: null,
      reps: null,
      lapses: null,
      state: null,
      lastReviewedAt: null,
      dueAt: null
    };
  }
  return { ...base, ...promptReviewColumns(built.review) };
}

// Record a review of one of the user's scheduled prompts: apply FSRS (#572), overwrite the prompt's card
// state, and append a history row — atomically. A draft cannot be reviewed (`not_scheduled`), and a
// missing or non-owned prompt is `not_found`.
export async function recordPromptReview(
  dependencies: MemoryDependencies,
  promptId: string,
  rating: ReviewRating,
  userId: string,
  now: Date
): Promise<RecordPromptReviewResult> {
  const existing = await getPromptRowForUser(dependencies.db, promptId, userId);
  if (existing === undefined) {
    return { status: "not_found" };
  }
  const currentState = promptReviewStateOrNull(existing);
  if (currentState === null) {
    return { status: "not_scheduled" };
  }

  const nextState = applyRating(currentState, rating, now);
  const columns = promptReviewColumns(nextState);
  const reviewId = dependencies.createId();

  await dependencies.db.transaction(async (tx) => {
    await tx.update(memoryPrompts).set(columns).where(eq(memoryPrompts.entryId, promptId));
    await tx
      .insert(memoryPromptReviews)
      .values({ id: reviewId, promptEntryId: promptId, rating, reviewedAt: now });
  });

  return { prompt: toMemoryPromptDto({ ...existing, ...columns }), status: "recorded" };
}

// Snooze defers a prompt OUT of today's batch by moving ONLY its `due_at` forward one day. It is NOT a
// rating: the FSRS card state is left untouched, so the schedule is unchanged. Only a scheduled prompt has
// a card to defer.
export async function snoozePrompt(
  db: DbClient,
  userId: string,
  promptId: string,
  now: Date
): Promise<SnoozePromptResult> {
  const existing = await getPromptRowForUser(db, promptId, userId);
  if (existing === undefined) {
    return { status: "not_found" };
  }
  if (promptReviewStateOrNull(existing) === null) {
    return { status: "not_scheduled" };
  }

  const dueAt = new Date(now.getTime() + SNOOZE_DEFER_DAYS * MS_PER_DAY);
  await db.update(memoryPrompts).set({ dueAt }).where(eq(memoryPrompts.entryId, promptId));

  return { prompt: toMemoryPromptDto({ ...existing, dueAt }), status: "snoozed" };
}

// The FSRS card columns nulled out — a draft carries no card. Used when an edit reverts a prompt to a
// draft (`clear`): the card state is dropped, but the append-only review LOG is deliberately untouched.
const nullReviewColumns = {
  stability: null,
  difficulty: null,
  elapsedDays: null,
  scheduledDays: null,
  learningSteps: null,
  reps: null,
  lapses: null,
  state: null,
  lastReviewedAt: null,
  dueAt: null
} as const;

// Edit a memory note's durable body (#573): rewrite its rich doc + readable projection and bump the
// shared personal-entry `updatedAt`, atomically. The capture source (structured provenance) is never
// rewritten. A missing or non-owned note is `not_found`. Prompts are untouched, so no review history is
// affected.
export async function editMemoryNote(
  dependencies: MemoryDependencies,
  noteId: string,
  userId: string,
  noteText: string,
  now: Date
): Promise<EditMemoryNoteResult> {
  const existing = await getMemoryNoteRowForUser(dependencies.db, userId, noteId);
  if (existing === undefined) {
    return { status: "not_found" };
  }
  await dependencies.db.transaction(async (tx) => {
    await tx
      .update(memoryNotes)
      .set({ bodyDoc: createTextDocument(noteText), bodyText: noteText })
      .where(eq(memoryNotes.entryId, noteId));
    await tx
      .update(personalEntries)
      .set({ updatedAt: now })
      .where(eq(personalEntries.entryId, noteId));
  });
  const detail = await getMemoryNoteDetail(dependencies.db, userId, noteId);
  // The note exists and is owned (just re-read under the same user scope), so detail is always present.
  return { detail: detail as MemoryNoteDetailDto, status: "updated" };
}

// Edit one prompt's cue/answer (#573), reconciling the edit with its schedule via the pure domain rule so
// editing content never silently resets review history: a prompt that stays schedulable keeps its card
// (FSRS columns untouched); a draft that becomes schedulable seeds a fresh card; a prompt that loses its
// revealable answer reverts to a draft and drops its card. The append-only review LOG is never deleted.
export async function editMemoryPrompt(
  dependencies: MemoryDependencies,
  promptId: string,
  userId: string,
  request: EditMemoryPromptRequest,
  now: Date
): Promise<EditMemoryPromptResult> {
  const existing = await getPromptRowForUser(dependencies.db, promptId, userId);
  if (existing === undefined) {
    return { status: "not_found" };
  }
  const answerText = request.answerText ?? null;
  const outcome = reconcilePromptEdit(existing.lifecycle, request.cueText, answerText);
  const base = {
    cueDoc: createTextDocument(request.cueText),
    cueText: request.cueText,
    answerDoc: answerText === null ? null : createTextDocument(answerText),
    answerText,
    lifecycle: outcome.lifecycle
  };
  const columns =
    outcome.reviewAction === "keep"
      ? base
      : outcome.reviewAction === "seed"
        ? { ...base, ...promptReviewColumns(newReviewState(now)) }
        : { ...base, ...nullReviewColumns };

  await dependencies.db
    .update(memoryPrompts)
    .set(columns)
    .where(eq(memoryPrompts.entryId, promptId));

  const updated = await getPromptRowForUser(dependencies.db, promptId, userId);
  return { prompt: toMemoryPromptDto(updated as MemoryPromptRow), status: "updated" };
}

// Add one additional retrieval direction to an existing note (#573): resolve its answer (an offline gloss
// suggestion when only a bare term is given), persist the prompt Entry + row + `contains` link, and bump
// the note's `updatedAt` — atomically. A missing or non-owned note is `not_found`. The new prompt is
// scheduled iff it has a meaningful cue and a revealable answer, else saved as a draft.
export async function addPromptToNote(
  dependencies: MemoryDependencies,
  noteId: string,
  userId: string,
  request: AddMemoryPromptRequest,
  now: Date
): Promise<AddMemoryPromptResult> {
  const note = await getMemoryNoteRowForUser(dependencies.db, userId, noteId);
  if (note === undefined) {
    return { status: "not_found" };
  }
  const answerText = await resolveAnswer(dependencies, request);
  const promptRow = buildPromptRow(
    {
      id: toEntryId(dependencies.createId()),
      cueText: request.cueText,
      answerText,
      chunkId: request.chunkId ?? null
    },
    toEntryId(noteId),
    now
  );
  await dependencies.db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: promptRow.entryId, type: "memory_prompt" });
    await tx.insert(memoryPrompts).values(promptRow);
    await tx.insert(entryLinks).values({
      fromEntryId: noteId,
      toEntryId: promptRow.entryId,
      type: "contains"
    });
    await tx
      .update(personalEntries)
      .set({ updatedAt: now })
      .where(eq(personalEntries.entryId, noteId));
  });
  const detail = await getMemoryNoteDetail(dependencies.db, userId, noteId);
  return { detail: detail as MemoryNoteDetailDto, status: "added" };
}

// Delete a memory note and everything under it (#573), atomically and FK-safe (children first): every
// prompt's review-log rows, then the note/prompt `entry_links`, then the prompt rows, then the prompt
// Entries, then the note row, its personal-entry facet, and finally the note Entry. A missing or
// non-owned note is `not_found` — one user can never delete another's note.
export async function deleteMemoryNote(
  dependencies: MemoryDependencies,
  noteId: string,
  userId: string
): Promise<DeleteMemoryNoteResult> {
  const note = await getMemoryNoteRowForUser(dependencies.db, userId, noteId);
  if (note === undefined) {
    return { status: "not_found" };
  }
  const promptRows = await dependencies.db
    .select({ entryId: memoryPrompts.entryId })
    .from(memoryPrompts)
    .where(eq(memoryPrompts.noteEntryId, noteId));
  const promptIds = promptRows.map((row) => row.entryId);
  const linkEntryIds = [noteId, ...promptIds];

  await dependencies.db.transaction(async (tx) => {
    if (promptIds.length > 0) {
      await tx
        .delete(memoryPromptReviews)
        .where(inArray(memoryPromptReviews.promptEntryId, promptIds));
    }
    await tx
      .delete(entryLinks)
      .where(
        or(
          inArray(entryLinks.fromEntryId, linkEntryIds),
          inArray(entryLinks.toEntryId, linkEntryIds)
        )
      );
    await tx.delete(memoryPrompts).where(eq(memoryPrompts.noteEntryId, noteId));
    if (promptIds.length > 0) {
      await tx.delete(entries).where(inArray(entries.id, promptIds));
    }
    await tx.delete(memoryNotes).where(eq(memoryNotes.entryId, noteId));
    await tx.delete(personalEntries).where(eq(personalEntries.entryId, noteId));
    await tx.delete(entries).where(eq(entries.id, noteId));
  });

  return { status: "deleted" };
}
