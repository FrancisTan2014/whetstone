import { caseCorpus } from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import { cases, chunks, domains } from "../../db/schema.js";

// Seed the authored case/map corpus (#205) into the database from the domain's canonical definition,
// the same idempotent way note templates are seeded: stable slug ids are the primary keys, so
// re-running on every boot inserts the corpus once and leaves existing rows untouched. Order indexes
// come from the authored array order so reads return domains/cases/chunks in their intended sequence.
export async function seedCaseCorpus(db: DbClient): Promise<void> {
  const domainRows = caseCorpus.map((domain, index) => ({
    id: domain.id,
    name: domain.name,
    orderIndex: index,
    weight: domain.weight
  }));

  const caseRows = caseCorpus.flatMap((domain) =>
    domain.cases.map((theCase, index) => ({
      communicativeFunction: theCase.communicativeFunction,
      domainId: domain.id,
      id: theCase.id,
      orderIndex: index,
      situation: theCase.situation
    }))
  );

  const chunkRows = caseCorpus.flatMap((domain) =>
    domain.cases.flatMap((theCase) =>
      theCase.chunks.map((chunk, index) => ({
        caseId: theCase.id,
        gloss: chunk.gloss ?? null,
        id: chunk.id,
        orderIndex: index,
        text: chunk.text,
        usageNote: chunk.usageNote ?? null
      }))
    )
  );

  await db.transaction(async (tx) => {
    await tx.insert(domains).values(domainRows).onConflictDoNothing();
    await tx.insert(cases).values(caseRows).onConflictDoNothing();
    await tx.insert(chunks).values(chunkRows).onConflictDoNothing();
  });
}
