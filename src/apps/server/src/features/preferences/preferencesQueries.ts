import { eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { readerPreferences } from "../../db/schema.js";

// The stored preferences for one user, or undefined when none yet (callers fall back to defaults).
export type StoredPreferences = Readonly<{
  readingSize: string;
  theme: string;
}>;

export async function getPreferences(
  db: DbClient,
  userId: string
): Promise<StoredPreferences | undefined> {
  const rows = await db
    .select({ readingSize: readerPreferences.readingSize, theme: readerPreferences.theme })
    .from(readerPreferences)
    .where(eq(readerPreferences.userId, userId))
    .limit(1);

  return rows[0];
}
