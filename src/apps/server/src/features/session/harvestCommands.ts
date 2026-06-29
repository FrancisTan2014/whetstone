import { asc, desc, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { cases, chunks, domains, noteAnchors, notes } from "../../db/schema.js";

// The reading -> speaking on-ramp (#243): the differentiator is that practice grows from what the user
// just read. The most recent reading capture (a note with a selected-text anchor) seeds a case whose
// target chunk IS that text, linked to the source block, so production recycles their reading. Seeding
// is idempotent (keyed off the note), and returns null when there is no capture (fall back to authored).
export type HarvestedCue = Readonly<{
  caseId: string;
  chunkId: string;
  communicativeFunction: string;
  situation: string;
  target: string;
}>;

export type HarvestDependencies = Readonly<{ createId: () => string; db: DbClient }>;

export async function harvestReadingCase(
  dependencies: HarvestDependencies,
  userId: string
): Promise<HarvestedCue | null> {
  const captures = await dependencies.db
    .select({
      blockEntryId: noteAnchors.blockEntryId,
      noteEntryId: notes.entryId,
      selectedText: noteAnchors.selectedText
    })
    .from(notes)
    .innerJoin(noteAnchors, eq(noteAnchors.noteEntryId, notes.entryId))
    .where(eq(notes.userId, userId))
    .orderBy(desc(notes.entryId))
    .limit(1);
  const capture = captures[0];
  if (capture === undefined) {
    return null;
  }

  const domainRows = await dependencies.db
    .select({ id: domains.id })
    .from(domains)
    .orderBy(asc(domains.orderIndex))
    .limit(1);
  const domainId = domainRows[0]?.id;
  if (domainId === undefined) {
    return null;
  }

  const caseId = `harvest-${capture.noteEntryId}`;
  const chunkId = `harvest-chunk-${capture.noteEntryId}`;
  const situation = "Use what you just read in a quick exchange.";
  const communicativeFunction = "Recycle a phrase from your reading";

  await dependencies.db
    .insert(cases)
    .values({
      briefKey: caseId,
      communicativeFunction,
      domainId,
      id: caseId,
      orderIndex: 0,
      situation
    })
    .onConflictDoNothing();
  await dependencies.db
    .insert(chunks)
    .values({
      caseId,
      id: chunkId,
      orderIndex: 0,
      sourceBlockEntryId: capture.blockEntryId,
      text: capture.selectedText
    })
    .onConflictDoNothing();

  return { caseId, chunkId, communicativeFunction, situation, target: capture.selectedText };
}
