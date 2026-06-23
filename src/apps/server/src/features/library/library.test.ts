import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import type { LibraryDependencies } from "./libraryCommands.js";
import { createServer } from "../../http/createServer.js";

type TestContext = Readonly<{
  server: ReturnType<typeof createServer>;
}>;

let context: TestContext;

async function buildContext(): Promise<TestContext> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = createDbClient(pglite);

  let authorSequence = 0;
  let entrySequence = 0;
  const dependencies: LibraryDependencies = {
    createAuthorId: () => `author-${(authorSequence += 1)}`,
    createEntryId: () => `work-${(entrySequence += 1)}`,
    db
  };

  return { server: createServer({ library: dependencies, logger: false }) };
}

beforeEach(async () => {
  context = await buildContext();
});

afterEach(async () => {
  await context.server.close();
});

describe("library routes", () => {
  it("creates authors and lists them sorted by name", async () => {
    const second = await context.server.inject({
      method: "POST",
      url: "/api/authors",
      payload: { name: "Zadie Smith" }
    });
    const first = await context.server.inject({
      method: "POST",
      url: "/api/authors",
      payload: { name: "Octavia Butler" }
    });

    expect(second.statusCode).toBe(201);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ id: "author-2", name: "Octavia Butler" });

    const list = await context.server.inject({ method: "GET", url: "/api/authors" });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({
      authors: [
        { id: "author-2", name: "Octavia Butler" },
        { id: "author-1", name: "Zadie Smith" }
      ]
    });
  });

  it("creates a work with a new inline author and persists both", async () => {
    const created = await context.server.inject({
      method: "POST",
      url: "/api/works",
      payload: {
        author: { mode: "new", name: "George Orwell" },
        language: "en",
        title: "Politics and the English Language",
        workType: "essay"
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      author: { id: "author-1", name: "George Orwell" },
      work: {
        authorId: "author-1",
        entryId: "work-1",
        language: "en",
        title: "Politics and the English Language",
        workType: "essay"
      }
    });

    const authors = await context.server.inject({ method: "GET", url: "/api/authors" });
    expect(authors.json()).toEqual({ authors: [{ id: "author-1", name: "George Orwell" }] });

    const works = await context.server.inject({ method: "GET", url: "/api/works" });
    expect(works.statusCode).toBe(200);
    expect(works.json()).toEqual({
      works: [
        {
          author: { id: "author-1", name: "George Orwell" },
          work: {
            authorId: "author-1",
            entryId: "work-1",
            language: "en",
            title: "Politics and the English Language",
            workType: "essay"
          }
        }
      ]
    });
  });

  it("creates a work for an existing author selected by id", async () => {
    const author = await context.server.inject({
      method: "POST",
      url: "/api/authors",
      payload: { name: "Charles Dickens" }
    });
    const authorId = author.json().id as string;

    const created = await context.server.inject({
      method: "POST",
      url: "/api/works",
      payload: {
        author: { authorId, mode: "existing" },
        language: "en",
        title: "A Tale of Two Cities",
        workType: "book"
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      author: { id: "author-1", name: "Charles Dickens" },
      work: {
        authorId: "author-1",
        entryId: "work-1",
        language: "en",
        title: "A Tale of Two Cities",
        workType: "book"
      }
    });
  });

  it("rejects a work that references a missing author", async () => {
    const response = await context.server.inject({
      method: "POST",
      url: "/api/works",
      payload: {
        author: { authorId: "missing-author", mode: "existing" },
        language: "en",
        title: "Orphan Work",
        workType: "book"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "author_not_found", authorId: "missing-author" });

    const works = await context.server.inject({ method: "GET", url: "/api/works" });
    expect(works.json()).toEqual({ works: [] });
  });

  it("rejects invalid author and work payloads at the boundary", async () => {
    const invalidAuthor = await context.server.inject({
      method: "POST",
      url: "/api/authors",
      payload: { name: "  " }
    });

    expect(invalidAuthor.statusCode).toBe(400);
    expect(invalidAuthor.json()).toEqual({ error: "invalid_request" });

    const invalidWork = await context.server.inject({
      method: "POST",
      url: "/api/works",
      payload: {
        author: { mode: "new", name: "x" },
        language: "en",
        title: "t",
        workType: "magazine"
      }
    });

    expect(invalidWork.statusCode).toBe(400);
    expect(invalidWork.json()).toEqual({ error: "invalid_request" });
  });

  it("returns empty lists before any data exists", async () => {
    const authors = await context.server.inject({ method: "GET", url: "/api/authors" });
    const works = await context.server.inject({ method: "GET", url: "/api/works" });

    expect(authors.json()).toEqual({ authors: [] });
    expect(works.json()).toEqual({ works: [] });
  });
});
