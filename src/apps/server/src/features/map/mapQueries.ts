import type {
  DomainDto,
  MapCaseDto,
  MapDomainDto,
  ProgressMapDto,
  ProgressSignalsDto
} from "@whetstone/contracts";
import { caseLightLevel, summarizeCaseMastery, type ReviewState } from "@whetstone/domain";
import { and, asc, eq, isNotNull } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { cases, chunks, domains, recallItems } from "../../db/schema.js";
import { rowToReviewState } from "../recall/recallQueries.js";
import { compileContext } from "../learner/learnerQueries.js";

// Group the user's recall review states by the chunk each item is linked to (their own items only).
async function reviewStatesByChunkId(
  db: DbClient,
  userId: string
): Promise<Map<string, ReviewState[]>> {
  const rows = await db
    .select()
    .from(recallItems)
    .where(and(eq(recallItems.userId, userId), isNotNull(recallItems.chunkId)));

  const byChunk = new Map<string, ReviewState[]>();
  for (const row of rows) {
    const chunkId = row.chunkId as string;
    const states = byChunk.get(chunkId) ?? [];
    states.push(rowToReviewState(row));
    byChunk.set(chunkId, states);
  }

  return byChunk;
}

function describeProgress(owned: number, weak: number, total: number): string {
  if (total === 0) {
    return "Your map is waiting — start anywhere to light up your first region.";
  }
  const weakClause = weak === 0 ? "nothing needs review right now" : `${weak} need review`;
  return `You own ${owned} of ${total} everyday phrasings; ${weakClause}.`;
}

// Compile the fog-of-war progress map for a user: every active domain -> cases lit/dim/dark from real
// mastery (#205/#189), plus the progress signals (owned/weak counts + error trend) and the coach's
// recommended next region (#208). Pure visualization — no scoring logic lives here.
export async function compileProgressMap(
  db: DbClient,
  userId: string,
  now: Date
): Promise<ProgressMapDto> {
  const domainRows = await db
    .select()
    .from(domains)
    .orderBy(asc(domains.orderIndex), asc(domains.id));

  const caseRows = await db
    .select()
    .from(cases)
    .where(eq(cases.status, "active"))
    .orderBy(asc(cases.domainId), asc(cases.orderIndex), asc(cases.id));

  const chunkRows = await db
    .select({ caseId: chunks.caseId, chunkId: chunks.id })
    .from(chunks)
    .innerJoin(cases, eq(chunks.caseId, cases.id))
    .where(eq(cases.status, "active"))
    .orderBy(asc(chunks.orderIndex), asc(chunks.id));

  const statesByChunkId = await reviewStatesByChunkId(db, userId);

  const chunkIdsByCase = new Map<string, string[]>();
  for (const row of chunkRows) {
    const ids = chunkIdsByCase.get(row.caseId) ?? [];
    ids.push(row.chunkId);
    chunkIdsByCase.set(row.caseId, ids);
  }

  const context = await compileContext(db, userId, now, { chunkLimit: 1 });
  const recommendedCaseId = context.rankedChunks[0]?.caseId ?? null;

  let ownedChunks = 0;
  let weakChunks = 0;
  let totalChunks = 0;

  const casesByDomain = new Map<string, MapCaseDto[]>();
  for (const caseRow of caseRows) {
    const chunkIds = chunkIdsByCase.get(caseRow.id) ?? [];
    const mastery = summarizeCaseMastery(chunkIds, statesByChunkId, now);
    ownedChunks += mastery.masteredChunks;
    weakChunks += mastery.dueChunks + mastery.learningChunks;
    totalChunks += mastery.totalChunks;

    const mapCase: MapCaseDto = {
      caseId: caseRow.id,
      communicativeFunction: caseRow.communicativeFunction,
      light: caseLightLevel(mastery),
      mastery: { caseId: caseRow.id, ...mastery },
      recommended: caseRow.id === recommendedCaseId,
      situation: caseRow.situation
    };

    const list = casesByDomain.get(caseRow.domainId) ?? [];
    list.push(mapCase);
    casesByDomain.set(caseRow.domainId, list);
  }

  const mapDomains: MapDomainDto[] = domainRows.map((row) => {
    const domain: DomainDto = { id: row.id, name: row.name, weight: row.weight };
    return { cases: casesByDomain.get(row.id) ?? [], domain };
  });

  const signals: ProgressSignalsDto = {
    errorTrend: [...context.relevantErrors],
    ownedChunks,
    summary: describeProgress(ownedChunks, weakChunks, totalChunks),
    totalChunks,
    weakChunks
  };

  return { domains: mapDomains, recommendedCaseId, signals };
}
