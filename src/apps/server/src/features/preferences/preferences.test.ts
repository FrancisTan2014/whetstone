import { PGlite } from "@electric-sql/pglite";
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { createServer } from "../../http/createServer.js";

type TestContext = Readonly<{ db: DbClient; server: ReturnType<typeof createServer> }>;

// What a test may send as a request body -- including shapes the route must reject. `NonNullable`
// because `exactOptionalPropertyTypes` forbids handing `inject` an explicitly `undefined` payload.
type InjectPayload = NonNullable<InjectOptions["payload"]>;

let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);
  return { db, server: createServer({ logger: false, preferences: { db } }) };
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.server.close();
});

function get() {
  return context.server.inject({ method: "GET", url: "/api/preferences" });
}

function put(payload: InjectPayload) {
  return context.server.inject({ method: "PUT", payload, url: "/api/preferences" });
}

describe("preferences routes", () => {
  it("returns defaults with a null timeZone (the first-use signal) when nothing is stored", async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      preferences: { readingSize: "md", theme: "day", timeZone: null }
    });
  });

  it("round-trips every field: PUT then GET restores the saved record", async () => {
    expect(
      (await put({ readingSize: "lg", theme: "night", timeZone: "America/New_York" })).statusCode
    ).toBe(204);

    expect((await get()).json()).toEqual({
      preferences: { readingSize: "lg", theme: "night", timeZone: "America/New_York" }
    });

    // Re-saving upserts in place rather than accumulating.
    expect(
      (await put({ readingSize: "xl", theme: "day", timeZone: "Asia/Shanghai" })).statusCode
    ).toBe(204);
    expect((await get()).json()).toEqual({
      preferences: { readingSize: "xl", theme: "day", timeZone: "Asia/Shanghai" }
    });
  });

  it("rejects an invalid record with 400", async () => {
    expect((await put({ readingSize: "huge", theme: "night", timeZone: "UTC" })).statusCode).toBe(
      400
    );
    expect((await put({ readingSize: "md", theme: "day" })).statusCode).toBe(400);
    // An invalid IANA zone is rejected rather than silently reinterpreted as the server's zone.
    expect((await put({ readingSize: "md", theme: "day", timeZone: "Not/AZone" })).statusCode).toBe(
      400
    );
  });
});
