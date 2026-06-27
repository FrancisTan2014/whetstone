import type { CaseDto } from "@whetstone/contracts";
import { and, asc, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { cases } from "../../db/schema.js";
import { toCaseDto } from "../cases/caseQueries.js";

// The review queue: authored cases still awaiting curation, optionally scoped to a domain. A curator
// reads these (and each case's chunks via `getCaseDetail`) before accepting or editing them.
export async function listCasesNeedingReview(
  db: DbClient,
  domainId?: string
): Promise<ReadonlyArray<CaseDto>> {
  const needsReview = eq(cases.status, "needs_review");
  const rows = await db
    .select()
    .from(cases)
    .where(domainId === undefined ? needsReview : and(needsReview, eq(cases.domainId, domainId)))
    .orderBy(asc(cases.domainId), asc(cases.orderIndex), asc(cases.id));

  return rows.map(toCaseDto);
}
