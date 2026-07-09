import type { CreateTimelineCaptureRequest, TimelineCaptureDto } from "@whetstone/contracts";
import { toDayKey } from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import { entries, timelineEntries } from "../../db/schema.js";
import { toTimelineCaptureDto } from "./timelineQueries.js";

// Real infrastructure boundaries (the database client and id generation) are injected so the commands
// stay deterministic and testable; `now` is passed in for the same reason.
export type MakeDurableDependencies = Readonly<{
  createId: () => string;
  db: DbClient;
  // Offline gloss autofill (#526): passed through to `enrollRecallItem` by `saveProposalRecallItem`.
  // Optional; absent means no autofill (the item keeps whatever gloss the proposal supplied).
  resolveOfflineGloss?: (text: string) => Promise<string | null>;
}>;

// Save a Quick Capture as a Timeline entry: register its owning Entry (`type = "timeline_entry"`) and
// the capture row in one transaction, so a capture never exists without its Entry (and vice versa). The
// server owns the id, `created_at` (the capture instant) and `entry_date` (today, from `now`) so the
// client cannot forge or backdate a capture. `tidied_text` is null here — tidy is a later async pass and
// capture must never block on it.
export async function createTimelineCapture(
  dependencies: MakeDurableDependencies,
  request: CreateTimelineCaptureRequest,
  userId: string,
  now: Date
): Promise<TimelineCaptureDto> {
  const entryId = dependencies.createId();
  const row = {
    entryId,
    userId,
    createdAt: now,
    entryDate: toDayKey(now),
    inputMode: request.inputMode,
    captureSource: request.captureSource,
    rawInputText: request.rawInputText,
    tidiedText: request.tidiedText ?? null,
    language: request.language ?? null,
    rawAudioPath: request.rawAudioPath ?? null,
    processingStatus: null,
    failureReason: null
  } as const;

  await dependencies.db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: entryId, type: "timeline_entry" });
    await tx.insert(timelineEntries).values(row);
  });

  return toTimelineCaptureDto(row);
}
