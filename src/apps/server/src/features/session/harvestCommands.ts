import { asc } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { cases, chunks, domains } from "../../db/schema.js";
import { selectReadingNudgeCapture } from "../nudge/nudgeCommands.js";

// The reading -> speaking on-ramp (#243): the differentiator is that practice grows from what the user
// just read. A recent reading capture (a note with a selected-text anchor) seeds a case whose target
// chunk IS that text, linked to the source block, so production recycles their reading. The capture is
// chosen by the SAME value ranking + cooldown as the Today nudge (#245) — the top-ranked, non-cooled
// capture, not merely the newest — so the Practice entry leads with the proposed case. Seeding is
// idempotent (keyed off the note), and returns null when there is no eligible capture (fall back to
// authored), or when there are no domains to attach a harvested case to.
export type HarvestedCue = Readonly<{
  caseId: string;
  chunkId: string;
  communicativeFunction: string;
  situation: string;
  target: string;
}>;

export async function harvestReadingCase(
  db: DbClient,
  userId: string,
  now: Date
): Promise<HarvestedCue | null> {
  const capture = await selectReadingNudgeCapture(db, userId, now);
  if (capture === undefined) {
    return null;
  }

  const domainRows = await db
    .select({ id: domains.id })
    .from(domains)
    .orderBy(asc(domains.orderIndex))
    .limit(1);
  const domainId = domainRows[0]?.id;
  if (domainId === undefined) {
    return null;
  }

  const { caseId, chunkId } = capture;
  const situation = "Use what you just read in a quick exchange.";
  const communicativeFunction = "Recycle a phrase from your reading";

  await db
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
  await db
    .insert(chunks)
    .values({
      caseId,
      id: chunkId,
      orderIndex: 0,
      sourceBlockEntryId: capture.blockEntryId,
      text: capture.text
    })
    .onConflictDoNothing();

  return { caseId, chunkId, communicativeFunction, situation, target: capture.text };
}
