import type {
  AddMemoryPromptRequest,
  DepositMemoryRequest,
  EditMemoryPromptRequest,
  MemoryDepositDto,
  MemoryNoteDetailDto,
  MemoryPromptDto
} from "@whetstone/contracts";
import {
  buildMemoryPrompt,
  RECALL_REQUEST_RETENTION,
  reconcilePromptEdit,
  toEntryId,
  type EntryId,
  type ReviewRating,
  type ReviewState
} from "@whetstone/domain";
import { createTextDocument, type DocumentNodeJSON } from "@whetstone/document";
import { eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { entries, entryLinks, memoryPrompts, personalEntries } from "../../db/schema.js";
import { deleteNoteInTx, insertNoteInTx, updateNoteBodyInTx } from "../notes/noteCommands.js";
import {
  deleteReviewCard,
  rateReviewCard,
  seedReviewCard,
  snoozeReviewCard
} from "../review/reviewCardCommands.js";
import { getReviewCardForUser, reviewStateFromCard } from "../review/reviewCardQueries.js";
import {
  getMemoryNoteDetail,
  getMemoryNoteRowForUser,
  getPromptRowForUser,
  toMemoryDepositDto,
  toMemoryPromptDto,
  type MemoryNoteRow,
  type MemoryPromptRow
} from "./memoryQueries.js";

// Real infrastructure boundaries (the database client, id generation) are injected so the commands stay
// deterministic and testable; `now` is passed in explicitly (and feeds the shared FSRS scheduler).
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

// One retrieval prompt to persist under a note, after the answer has been resolved. `cueDoc`/`answerDoc`
// carry a rich authoring surface's supplied document (the paste-a-list import, #574); when null the row
// builder derives a plain single-block document from the text, so plain-text feeders stay unchanged.
type ResolvedPrompt = Readonly<{
  id: EntryId;
  cueText: string;
  answerText: string | null;
  cueDoc: DocumentNodeJSON | null;
  answerDoc: DocumentNodeJSON | null;
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

// The transaction handle drizzle passes into `db.transaction`, so a shared write helper can run inside a
// caller's transaction — and card seeding can compose in the same atomic write as the note/prompts.
type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// Atomically insert a memory note (through the shared Notes boundary: its Entry + ownership facet + unified
// `notes` row + optional `derived_from` provenance link), and each prompt (Entry + row + `contains` link),
// seeding a shared review card for each ready prompt in the same transaction. A memory note is unanchored,
// so it passes `anchor: null`; its capture source and body flow straight into the one note facet. Returns
// the seeded review states keyed by prompt id (absent for a draft) so the caller can project each prompt's
// schedule without a re-read. Shared by every deposit path.
async function writeMemory(
  tx: Transaction,
  params: Readonly<{
    noteRow: MemoryNoteRow;
    derivedFromEntryId: string | null;
    promptRows: ReadonlyArray<MemoryPromptRow>;
    userId: string;
    now: Date;
  }>
): Promise<Map<string, ReviewState>> {
  const { noteRow, derivedFromEntryId, promptRows, userId, now } = params;
  await insertNoteInTx(tx, {
    anchor: null,
    bodyDoc: noteRow.bodyDoc,
    bodyText: noteRow.bodyText,
    captureSource: noteRow.captureSource,
    derivedFromEntryId,
    kind: "note",
    noteEntryId: toEntryId(noteRow.entryId),
    now,
    userId
  });
  const reviews = new Map<string, ReviewState>();
  for (const promptRow of promptRows) {
    await tx.insert(entries).values({ id: promptRow.entryId, type: "memory_prompt" });
    await tx.insert(memoryPrompts).values(promptRow);
    await tx.insert(entryLinks).values({
      fromEntryId: noteRow.entryId,
      toEntryId: promptRow.entryId,
      type: "contains"
    });
    if (promptRow.lifecycle === "ready") {
      const state = await seedReviewCard(tx, {
        targetEntryId: promptRow.entryId,
        userId,
        requestedRetention: RECALL_REQUEST_RETENTION,
        now
      });
      reviews.set(promptRow.entryId, state);
    }
  }
  return reviews;
}

export async function depositMemory(
  dependencies: MemoryDependencies,
  request: DepositMemoryRequest,
  userId: string,
  now: Date
): Promise<MemoryDepositDto> {
  const prepared = await prepareDeposit(dependencies, request, now);

  const reviews = await dependencies.db.transaction((tx) =>
    writeMemory(tx, { ...prepared, userId, now })
  );

  return toMemoryDepositDto(
    prepared.noteRow,
    prepared.derivedFromEntryId,
    prepared.promptRows,
    reviews
  );
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
      cueDoc: prompt.cueDoc ?? null,
      answerDoc: prompt.answerDoc ?? null,
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

  const results: MemoryDepositDto[] = [];
  await dependencies.db.transaction(async (tx) => {
    for (const deposit of prepared) {
      const reviews = await writeMemory(tx, { ...deposit, userId, now });
      results.push(
        toMemoryDepositDto(deposit.noteRow, deposit.derivedFromEntryId, deposit.promptRows, reviews)
      );
    }
  });

  return results;
}

// Build the persisted prompt row (content + content lifecycle only). Scheduling is no longer stored on the
// prompt: a ready prompt's review card is seeded separately in the shared substrate (#617). The lifecycle
// is decided by the domain from the cue/answer — `ready` iff both are meaningful, else `draft`.
function buildPromptRow(prompt: ResolvedPrompt, noteId: EntryId, now: Date): MemoryPromptRow {
  const built = buildMemoryPrompt({
    id: prompt.id,
    noteId,
    cueText: prompt.cueText,
    answerText: prompt.answerText,
    chunkId: prompt.chunkId
  });
  return {
    entryId: prompt.id,
    noteEntryId: noteId,
    cueDoc: prompt.cueDoc ?? createTextDocument(prompt.cueText),
    cueText: prompt.cueText,
    answerDoc:
      prompt.answerText === null
        ? null
        : (prompt.answerDoc ?? createTextDocument(prompt.answerText)),
    answerText: prompt.answerText,
    lifecycle: built.lifecycle,
    chunkId: prompt.chunkId,
    createdAt: now
  };
}

// Record a review of one of the user's ready prompts (#572): apply FSRS through the shared review-card
// substrate, which overwrites the card and appends the review event atomically. A draft has no card
// (`not_scheduled`), and a missing or non-owned prompt is `not_found`.
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
  const result = await rateReviewCard(
    { createId: dependencies.createId, db: dependencies.db },
    promptId,
    userId,
    rating,
    now
  );
  if (result.status === "not_found") {
    return { status: "not_scheduled" };
  }
  return { prompt: toMemoryPromptDto(existing, result.state), status: "recorded" };
}

// Snooze defers a prompt OUT of today's batch by moving ONLY its shared card's `due_at` forward one day.
// It is NOT a rating: the FSRS card state is left untouched and no review event is written, so the
// schedule is unchanged. Only a ready, enrolled prompt has a card to defer (`not_scheduled` otherwise).
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
  const result = await snoozeReviewCard(db, promptId, userId, now);
  if (result.status === "not_found") {
    return { status: "not_scheduled" };
  }
  return {
    prompt: toMemoryPromptDto(existing, reviewStateFromCard(result.card)),
    status: "snoozed"
  };
}

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
  await dependencies.db.transaction((tx) =>
    updateNoteBodyInTx(tx, { bodyDoc: createTextDocument(noteText), noteEntryId: noteId, now })
  );
  const detail = await getMemoryNoteDetail(dependencies.db, userId, noteId);
  // The note exists and is owned (just re-read under the same user scope), so detail is always present.
  return { detail: detail as MemoryNoteDetailDto, status: "updated" };
}

// Edit one prompt's cue/answer (#573), reconciling the edit with its shared review card via the pure
// domain rule so editing content never silently resets review history: a prompt that stays ready keeps its
// card (untouched); a draft that becomes ready seeds a fresh card; a prompt that loses its revealable
// answer reverts to a draft and drops its card. The append-only review EVENT history is never deleted.
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
  const content = {
    cueDoc: createTextDocument(request.cueText),
    cueText: request.cueText,
    answerDoc: answerText === null ? null : createTextDocument(answerText),
    answerText,
    lifecycle: outcome.lifecycle
  };

  await dependencies.db.transaction(async (tx) => {
    await tx.update(memoryPrompts).set(content).where(eq(memoryPrompts.entryId, promptId));
    if (outcome.reviewAction === "seed") {
      await seedReviewCard(tx, {
        targetEntryId: promptId,
        userId,
        requestedRetention: RECALL_REQUEST_RETENTION,
        now
      });
    } else if (outcome.reviewAction === "clear") {
      await deleteReviewCard(tx, promptId);
    }
  });

  const updated = await getPromptRowForUser(dependencies.db, promptId, userId);
  const card = await getReviewCardForUser(dependencies.db, promptId, userId);
  return {
    prompt: toMemoryPromptDto(
      updated as MemoryPromptRow,
      card === undefined ? null : reviewStateFromCard(card)
    ),
    status: "updated"
  };
}

// Add one additional retrieval direction to an existing note (#573): resolve its answer (an offline gloss
// suggestion when only a bare term is given), persist the prompt Entry + row + `contains` link, seed a
// shared review card when the direction is ready, and bump the note's `updatedAt` — atomically. A missing
// or non-owned note is `not_found`.
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
      cueDoc: request.cueDoc ?? null,
      answerDoc: request.answerDoc ?? null,
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
    if (promptRow.lifecycle === "ready") {
      await seedReviewCard(tx, {
        targetEntryId: promptRow.entryId,
        userId,
        requestedRetention: RECALL_REQUEST_RETENTION,
        now
      });
    }
    await tx
      .update(personalEntries)
      .set({ updatedAt: now })
      .where(eq(personalEntries.entryId, noteId));
  });
  const detail = await getMemoryNoteDetail(dependencies.db, userId, noteId);
  return { detail: detail as MemoryNoteDetailDto, status: "added" };
}

// Delete a memory note and everything under it (#573, #620), atomically, through the single Notes-owned
// cascade `deleteNoteInTx`: every prompt's shared review card + append-only events, the note/prompt
// `entry_links`, the prompt rows and Entries, then the note's row, its personal-entry facet, and the note
// Entry. A missing or non-owned note is `not_found` — one user can never delete another's note.
export async function deleteMemoryNote(
  dependencies: MemoryDependencies,
  noteId: string,
  userId: string
): Promise<DeleteMemoryNoteResult> {
  const note = await getMemoryNoteRowForUser(dependencies.db, userId, noteId);
  if (note === undefined) {
    return { status: "not_found" };
  }

  await dependencies.db.transaction((tx) => deleteNoteInTx(tx, noteId));

  return { status: "deleted" };
}
