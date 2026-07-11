import type { CaseDetailDto, CaseDto, ChunkDto, DomainDto } from "@whetstone/contracts";
import { summarizeCaseMastery } from "@whetstone/domain";
import { asc, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { cases, chunks, domains } from "../../db/schema.js";
import { reviewStatesByChunkIds } from "../memory/memoryQueries.js";

type DomainRow = typeof domains.$inferSelect;
type CaseRow = typeof cases.$inferSelect;
type ChunkRow = typeof chunks.$inferSelect;

function toDomainDto(row: DomainRow): DomainDto {
  return { id: row.id, name: row.name, weight: row.weight };
}

export function toCaseDto(row: CaseRow): CaseDto {
  return {
    communicativeFunction: row.communicativeFunction,
    domainId: row.domainId,
    id: row.id,
    situation: row.situation
  };
}

export function toChunkDto(row: ChunkRow): ChunkDto {
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

// A case's full chunk inventory plus the current user's per-case mastery summary, computed (never
// stored) from the user's scheduled Memory prompts linked to the case's chunks. Returns undefined for
// an unknown case so the caller can answer 404.
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
  const statesByChunkId = await reviewStatesByChunkIds(db, userId, chunkIds);
  const summary = summarizeCaseMastery(chunkIds, statesByChunkId, now);

  return {
    case: toCaseDto(caseRow),
    chunks: chunkRows.map(toChunkDto),
    mastery: { caseId, ...summary }
  };
}
