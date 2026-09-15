import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDbClient, type DbClient } from "../db/dbClient.js";
import { runMigrations } from "../db/migrate.js";
import { getLastNotifiedDayKey, setLastNotifiedDayKey } from "./dueRecitationNotificationState.js";

const USER_ID = "user-1";

let pglite: PGlite;
let db: DbClient;

beforeEach(async () => {
  pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
});

afterEach(async () => {
  await pglite.close();
});

describe("dueRecitationNotificationState", () => {
  it("returns undefined when no state has been recorded for the user", async () => {
    await expect(getLastNotifiedDayKey(db, USER_ID)).resolves.toBeUndefined();
  });

  it("persists and returns the last notified day key", async () => {
    await setLastNotifiedDayKey(db, USER_ID, "2026-09-15");

    await expect(getLastNotifiedDayKey(db, USER_ID)).resolves.toBe("2026-09-15");
  });

  it("overwrites the previously recorded day key for the same user", async () => {
    await setLastNotifiedDayKey(db, USER_ID, "2026-09-15");
    await setLastNotifiedDayKey(db, USER_ID, "2026-09-16");

    await expect(getLastNotifiedDayKey(db, USER_ID)).resolves.toBe("2026-09-16");
  });
});
