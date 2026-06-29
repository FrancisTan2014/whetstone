import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { createServer } from "../../http/createServer.js";

type TestContext = Readonly<{ db: DbClient; server: ReturnType<typeof createServer> }>;

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

function put(payload: unknown) {
  return context.server.inject({ method: "PUT", payload, url: "/api/preferences" });
}

describe("preferences routes", () => {
  it("returns defaults when nothing is stored", async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ preferences: { readingSize: "md", theme: "day" } });
  });

  it("round-trips both fields: PUT then GET restores the saved record", async () => {
    expect((await put({ readingSize: "lg", theme: "night" })).statusCode).toBe(204);

    expect((await get()).json()).toEqual({ preferences: { readingSize: "lg", theme: "night" } });

    // Re-saving upserts in place rather than accumulating.
    expect((await put({ readingSize: "xl", theme: "day" })).statusCode).toBe(204);
    expect((await get()).json()).toEqual({ preferences: { readingSize: "xl", theme: "day" } });
  });

  it("rejects an invalid record with 400", async () => {
    expect((await put({ readingSize: "huge", theme: "night" })).statusCode).toBe(400);
    expect((await put({ readingSize: "md" })).statusCode).toBe(400);
  });
});
