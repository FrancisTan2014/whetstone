import { eq } from "drizzle-orm";

import type { DbClient } from "../db/dbClient.js";
import { dueRecitationNotificationState } from "../db/schema.js";

// Persisted last-sent day key for the daily due-recitation notification (#933), so a server restart
// does not lose "already sent today" and re-send a nudge that already went out.
export async function getLastNotifiedDayKey(
  db: DbClient,
  userId: string
): Promise<string | undefined> {
  const rows = await db
    .select({ lastNotifiedDayKey: dueRecitationNotificationState.lastNotifiedDayKey })
    .from(dueRecitationNotificationState)
    .where(eq(dueRecitationNotificationState.userId, userId))
    .limit(1);

  return rows[0]?.lastNotifiedDayKey;
}

export async function setLastNotifiedDayKey(
  db: DbClient,
  userId: string,
  dayKey: string
): Promise<void> {
  const updatedAt = new Date();

  await db
    .insert(dueRecitationNotificationState)
    .values({ lastNotifiedDayKey: dayKey, updatedAt, userId })
    .onConflictDoUpdate({
      set: { lastNotifiedDayKey: dayKey, updatedAt },
      target: dueRecitationNotificationState.userId
    });
}
