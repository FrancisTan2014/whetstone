import type { UpsertPreferencesRequest } from "@whetstone/contracts";

import type { DbClient } from "../../db/dbClient.js";
import { readerPreferences } from "../../db/schema.js";

// The database client is injected so the command stays deterministic and testable.
export type PreferencesDependencies = Readonly<{ db: DbClient }>;

// Save the user's reader preferences: one row per user, re-saving updates in place. v0 has a single
// default user; the row is work-independent so settings restore on any device.
export async function upsertPreferences(
  dependencies: PreferencesDependencies,
  userId: string,
  request: UpsertPreferencesRequest
): Promise<void> {
  const updatedAt = new Date();

  await dependencies.db
    .insert(readerPreferences)
    .values({ readingSize: request.readingSize, theme: request.theme, updatedAt, userId })
    .onConflictDoUpdate({
      set: { readingSize: request.readingSize, theme: request.theme, updatedAt },
      target: readerPreferences.userId
    });
}
