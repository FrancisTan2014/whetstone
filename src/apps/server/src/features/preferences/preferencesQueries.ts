import { eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { readerPreferences } from "../../db/schema.js";

// The zone used for a learner's local calendar day when none is stored yet (#606): a safe, machine-
// independent fallback, never the server's own zone. First-use defaulting on the client persists the
// browser's resolved zone, after which the stored value is used.
export const FALLBACK_TIME_ZONE = "UTC";

// The stored preferences for one user, or undefined when none yet (callers fall back to defaults).
// `timeZone` is null until first-use defaulting persists the learner's zone.
export type StoredPreferences = Readonly<{
  readingSize: string;
  theme: string;
  timeZone: string | null;
}>;

export async function getPreferences(
  db: DbClient,
  userId: string
): Promise<StoredPreferences | undefined> {
  const rows = await db
    .select({
      readingSize: readerPreferences.readingSize,
      theme: readerPreferences.theme,
      timeZone: readerPreferences.timezone
    })
    .from(readerPreferences)
    .where(eq(readerPreferences.userId, userId))
    .limit(1);

  return rows[0];
}

// The learner's IANA calendar-day zone, or the fallback when unset (#606) — the single resolver every
// day-grouping/cap query routes through, so no feature reads the host machine's date as learner state. A
// stored zone is always a valid IANA id (validated at the write boundary).
export async function getLearnerTimeZone(db: DbClient, userId: string): Promise<string> {
  const stored = await getPreferences(db, userId);
  return stored?.timeZone ?? FALLBACK_TIME_ZONE;
}
