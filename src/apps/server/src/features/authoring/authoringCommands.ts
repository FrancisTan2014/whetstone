import type {
  AuthorCaseRequest,
  AuthoredCaseDto,
  CaseStatus,
  ReviewCaseRequest
} from "@whetstone/contracts";
import { asc, eq } from "drizzle-orm";

import type { CoachProvider } from "../../coach/coachProvider.js";
import type { DbClient } from "../../db/dbClient.js";
import { cases, chunks, domains } from "../../db/schema.js";
import { toCaseDto, toChunkDto } from "../cases/caseQueries.js";

// Real infrastructure boundaries are injected so authoring stays deterministic and testable: the coach
// seam (#206, routed to a cheap model for generation), the database, and id generation. The whole
// command runs on `FakeCoach` in tests.
export type AuthoringDependencies = Readonly<{
  coach: CoachProvider;
  createCaseId: () => string;
  createChunkId: () => string;
  db: DbClient;
}>;

export type AuthorCaseOutcome =
  | Readonly<{ authored: AuthoredCaseDto; status: "ok" }>
  | Readonly<{ status: "domain_not_found" }>;

export type ReviewCaseOutcome =
  | Readonly<{ reviewed: AuthoredCaseDto; status: "ok" }>
  | Readonly<{ status: "not_found" }>;

// A deterministic key for an authoring brief: same domain + situation + communicative function (modulo
// case and whitespace) maps to the same authored case, so re-requesting reuses the cached one. The
// unit-separator delimiter is safe to store in Postgres text (unlike a NUL byte) and never appears in
// normal briefs.
function makeBriefKey(request: AuthorCaseRequest): string {
  const normalize = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();
  return [
    request.domainId,
    normalize(request.situation),
    normalize(request.communicativeFunction)
  ].join("\u001f");
}

async function loadChunks(
  db: DbClient,
  caseId: string
): Promise<Array<typeof chunks.$inferSelect>> {
  return db
    .select()
    .from(chunks)
    .where(eq(chunks.caseId, caseId))
    .orderBy(asc(chunks.orderIndex), asc(chunks.id));
}

function toAuthoredCaseDto(
  caseRow: typeof cases.$inferSelect,
  chunkRows: ReadonlyArray<typeof chunks.$inferSelect>,
  cached: boolean
): AuthoredCaseDto {
  return {
    cached,
    case: toCaseDto(caseRow),
    chunks: chunkRows.map(toChunkDto),
    status: caseRow.status as CaseStatus
  };
}

// Author a new case into a domain the learner lacks, just-in-time and cached: if the brief was authored
// before, the stored case is returned with no model call; otherwise the coach authors a case + chunk
// inventory, which is persisted as `needs_review` (never blindly trusted, never live during practice).
export async function authorCase(
  dependencies: AuthoringDependencies,
  request: AuthorCaseRequest
): Promise<AuthorCaseOutcome> {
  const briefKey = makeBriefKey(request);

  const cachedRows = await dependencies.db
    .select()
    .from(cases)
    .where(eq(cases.briefKey, briefKey))
    .limit(1);
  const cachedCase = cachedRows[0];
  if (cachedCase !== undefined) {
    const chunkRows = await loadChunks(dependencies.db, cachedCase.id);
    return { authored: toAuthoredCaseDto(cachedCase, chunkRows, true), status: "ok" };
  }

  const domainRows = await dependencies.db
    .select({ id: domains.id })
    .from(domains)
    .where(eq(domains.id, request.domainId))
    .limit(1);
  if (domainRows[0] === undefined) {
    return { status: "domain_not_found" };
  }

  const result = await dependencies.coach.authorCase({
    communicativeFunction: request.communicativeFunction,
    domainId: request.domainId,
    situation: request.situation
  });

  const siblings = await dependencies.db
    .select({ id: cases.id })
    .from(cases)
    .where(eq(cases.domainId, request.domainId));
  const caseId = dependencies.createCaseId();
  const caseRow = {
    briefKey,
    communicativeFunction: result.communicativeFunction,
    domainId: request.domainId,
    id: caseId,
    orderIndex: siblings.length,
    situation: result.situation,
    status: "needs_review" as const
  };
  const chunkRows = result.chunks.map((chunk, index) => ({
    caseId,
    gloss: chunk.gloss,
    id: dependencies.createChunkId(),
    orderIndex: index,
    sourceBlockEntryId: null,
    text: chunk.text,
    usageNote: chunk.usageNote
  }));

  await dependencies.db.transaction(async (tx) => {
    await tx.insert(cases).values(caseRow);
    if (chunkRows.length > 0) {
      await tx.insert(chunks).values(chunkRows);
    }
  });

  return { authored: toAuthoredCaseDto(caseRow, chunkRows, false), status: "ok" };
}

// Review an authored case: optionally edit its situation / communicative function, then activate it so
// practice can use it. Curated, not blindly trusted.
export async function reviewCase(
  dependencies: AuthoringDependencies,
  caseId: string,
  request: ReviewCaseRequest
): Promise<ReviewCaseOutcome> {
  const existingRows = await dependencies.db
    .select()
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1);
  const existing = existingRows[0];
  if (existing === undefined) {
    return { status: "not_found" };
  }

  const situation = request.situation ?? existing.situation;
  const communicativeFunction = request.communicativeFunction ?? existing.communicativeFunction;

  await dependencies.db
    .update(cases)
    .set({ communicativeFunction, situation, status: "active" })
    .where(eq(cases.id, caseId));

  const updated = { ...existing, communicativeFunction, situation, status: "active" as const };
  const chunkRows = await loadChunks(dependencies.db, caseId);
  return { reviewed: toAuthoredCaseDto(updated, chunkRows, false), status: "ok" };
}
