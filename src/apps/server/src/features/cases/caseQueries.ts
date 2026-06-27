import type { CaseDetailDto, CaseDto, ChunkDto, DomainDto } from "@whetstone/contracts";
import { summarizeCaseMastery, type ReviewState } from "@whetstone/domain";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { cases, chunks, domains, recallItems } from "../../db/schema.js";
import { rowToReviewState } from "../recall/recallQueries.js";

type DomainRow = typeof domains.$inferSelect;
type CaseRow = typeof cases.$inferSelect;
type ChunkRow = typeof chunks.$inferSelect;

function toDomainDto(row: DomainRow): DomainDto {
  return { id: row.id, name: row.name, weight: row.weight };
}

function toCaseDto(row: CaseRow): CaseDto {
  return {
    communicativeFunction: row.communicativeFunction,
    domainId: row.domainId,
    id: row.id,
    situation: row.situation
  };
}

function toChunkDto(row: ChunkRow): ChunkDto {
  return {
    caseId: row.caseId,
    gloss: row.gloss,
    id: row.id,
    text: row.text,
    usageNote: row.usageNote
  };
}

// All authored domains, in their seeded order (the corpus's frequency/importance sequence).
export async function listDomains(db: DbClient): Promise<ReadonlyArray<DomainDto>> {
  const rows = await db.select().from(domains).orderBy(asc(domains.orderIndex), asc(domains.id));

  return rows.map(toDomainDto);
}

// The cases within a domain, in their seeded order. Empty for an unknown domain.
export async function listCasesInDomain(
  db: DbClient,
  domainId: string
): Promise<ReadonlyArray<CaseDto>> {
  const rows = await db
    .select()
    .from(cases)
    .where(eq(cases.domainId, domainId))
    .orderBy(asc(cases.orderIndex), asc(cases.id));

  return rows.map(toCaseDto);
}

// Group a user's review states by the chunk each item is linked to, so mastery can be derived per
// chunk. Only the user's own items are loaded, so one user's progress never leaks into another's.
async function reviewStatesByChunkId(
  db: DbClient,
  userId: string,
  chunkIds: ReadonlyArray<string>
): Promise<Map<string, ReviewState[]>> {
  const byChunk = new Map<string, ReviewState[]>();
  if (chunkIds.length === 0) {
    return byChunk;
  }

  const rows = await db
    .select()
    .from(recallItems)
    .where(and(eq(recallItems.userId, userId), inArray(recallItems.chunkId, chunkIds)));

  for (const row of rows) {
    // `chunkId` is non-null here: the `inArray` filter only matches rows whose chunk_id is one of
    // the requested ids.
    const chunkId = row.chunkId as string;
    const states = byChunk.get(chunkId) ?? [];
    states.push(rowToReviewState(row));
    byChunk.set(chunkId, states);
  }

  return byChunk;
}

// A case's full chunk inventory plus the current user's per-case mastery summary, computed (never
// stored) from the user's recall items linked to the case's chunks. Returns undefined for an unknown
// case so the caller can answer 404.
export async function getCaseDetail(
  db: DbClient,
  caseId: string,
  userId: string,
  now: Date
): Promise<CaseDetailDto | undefined> {
  const caseRows = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
  const caseRow = caseRows[0];
  if (caseRow === undefined) {
    return undefined;
  }

  const chunkRows = await db
    .select()
    .from(chunks)
    .where(eq(chunks.caseId, caseId))
    .orderBy(asc(chunks.orderIndex), asc(chunks.id));

  const chunkIds = chunkRows.map((row) => row.id);
  const statesByChunkId = await reviewStatesByChunkId(db, userId, chunkIds);
  const summary = summarizeCaseMastery(chunkIds, statesByChunkId, now);

  return {
    case: toCaseDto(caseRow),
    chunks: chunkRows.map(toChunkDto),
    mastery: { caseId, ...summary }
  };
}
