import type {
  NotePromptSettingsListDto,
  ReviewHistoryEventDto,
  ReviewHistoryPageDto
} from "@whetstone/contracts";
import type { EntryId } from "@whetstone/domain";
import { and, asc, desc, eq, lt, or } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { memoryPrompts, reviewCards, reviewEvents } from "../../db/schema.js";
import { getNoteForOwner } from "../notes/noteQueries.js";
import { getPromptRowForUser } from "../memory/memoryQueries.js";
import { projectPromptSettings } from "./notesReviewSettingsProjection.js";

// How many history events one page returns. The query fetches one extra to decide `nextCursor` without a
// second count.
const HISTORY_PAGE_SIZE = 20;

// An opaque history cursor: the last returned event's `occurred_at` and `id`, so the next page continues
// keyset-style past exactly that event. It is base64 so a client never constructs a query from raw
// columns — it echoes back what the server handed it.
type HistoryCursor = Readonly<{ occurredAt: Date; id: string }>;

function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(`${cursor.occurredAt.toISOString()}|${cursor.id}`, "utf8").toString(
    "base64url"
  );
}

// Decode an opaque cursor back to its keyset. `undefined` is the first page (no cursor). A malformed or
// non-decodable cursor is `invalid` so the route can answer 400 rather than silently ignoring it and
// returning the first page again (which would look like an infinite loop to the client).
function decodeHistoryCursor(raw: string | undefined): HistoryCursor | "invalid" | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");
  if (separator <= 0) {
    return "invalid";
  }
  const occurredAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(occurredAt.getTime()) || id.length === 0) {
    return "invalid";
  }
  return { occurredAt, id };
}

// The reveal-policy list of every prompt a note owns (#660), owner-scoped and in creation order (prompt id
// as the stable tiebreak), each with its projected card state. Returns `undefined` when the note is not the
// caller's or is a Mark (never a retrieval target), so the route answers 404. A cardless prompt still
// appears — projected `not_in_review` — so a removed prompt can be re-added from the same list.
export async function listNotePromptSettings(
  db: DbClient,
  userId: string,
  noteEntryId: EntryId,
  now: Date
): Promise<NotePromptSettingsListDto | undefined> {
  const note = await getNoteForOwner(db, noteEntryId, userId);
  if (note === undefined || note.kind !== "note") {
    return undefined;
  }

  const rows = await db
    .select({ prompt: memoryPrompts, card: reviewCards })
    .from(memoryPrompts)
    .leftJoin(
      reviewCards,
      and(eq(reviewCards.targetEntryId, memoryPrompts.entryId), eq(reviewCards.userId, userId))
    )
    .where(eq(memoryPrompts.noteEntryId, noteEntryId))
    .orderBy(asc(memoryPrompts.createdAt), asc(memoryPrompts.entryId));

  return {
    prompts: rows.map((row) => projectPromptSettings(row.prompt, row.card ?? undefined, now))
  };
}

// The outcome of reading a prompt's history page: the page, or `not_found` (prompt not the caller's), or
// `invalid_cursor` (a malformed opaque cursor) — each mapped to its own status by the route.
export type NoteReviewHistoryOutcome =
  | Readonly<{ status: "ok"; value: ReviewHistoryPageDto }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "invalid_cursor" }>;

function toHistoryEventDto(row: typeof reviewEvents.$inferSelect): ReviewHistoryEventDto {
  if (row.type === "reset") {
    return { id: row.id, kind: "reset", occurredAt: row.occurredAt.toISOString() };
  }
  // The check constraint guarantees a `rating` row carries a non-null rating.
  return {
    id: row.id,
    kind: "rating",
    rating: row.rating as NonNullable<typeof row.rating>,
    occurredAt: row.occurredAt.toISOString()
  };
}

// One page of a prompt's append-only Review history (#660), newest first (occurred_at desc, id desc as the
// stable tiebreak), owner-scoped through the prompt's note facet. Returns `not_found` when the prompt is not
// the caller's — even for a cardless prompt, since history outlives its card, so a removed-and-re-added
// prompt keeps its record. A malformed cursor is `invalid_cursor`. It reads only real card events (ratings
// and resets); it never fabricates an entry for reveal, pause, resume, enrollment, or removal.
export async function loadNoteReviewHistoryPage(
  db: DbClient,
  userId: string,
  promptId: string,
  rawCursor: string | undefined
): Promise<NoteReviewHistoryOutcome> {
  const prompt = await getPromptRowForUser(db, promptId, userId);
  if (prompt === undefined) {
    return { status: "not_found" };
  }

  const cursor = decodeHistoryCursor(rawCursor);
  if (cursor === "invalid") {
    return { status: "invalid_cursor" };
  }

  const keyset =
    cursor === undefined
      ? eq(reviewEvents.targetEntryId, promptId)
      : and(
          eq(reviewEvents.targetEntryId, promptId),
          or(
            lt(reviewEvents.occurredAt, cursor.occurredAt),
            and(eq(reviewEvents.occurredAt, cursor.occurredAt), lt(reviewEvents.id, cursor.id))
          )
        );

  const rows = await db
    .select()
    .from(reviewEvents)
    .where(keyset)
    .orderBy(desc(reviewEvents.occurredAt), desc(reviewEvents.id))
    .limit(HISTORY_PAGE_SIZE + 1);

  const hasMore = rows.length > HISTORY_PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, HISTORY_PAGE_SIZE) : rows;
  let nextCursor: string | null = null;
  if (hasMore) {
    const last = pageRows[pageRows.length - 1]!;
    nextCursor = encodeHistoryCursor({ occurredAt: last.occurredAt, id: last.id });
  }

  return {
    status: "ok",
    value: { events: pageRows.map(toHistoryEventDto), nextCursor }
  };
}
