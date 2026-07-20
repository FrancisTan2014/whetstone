import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #695 explicit Work content authority. Migration 0059 adds the required `work_meta.origin`, classifies
// every existing Work from its provenance + ownership shape, seeds the v0 owner facet onto migrated
// manual Works, and aborts the whole migration on any contradictory or uninferrable shape rather than
// guessing. These tests hand-build the pre-migration schema (work_meta had no `origin`) and apply ONLY
// the new SQL file, so they exercise the real backfill classification, seeding, and fail-loud logic in
// isolation, and prove nothing else is mutated.

const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "0059_complete_leo.sql"
);

async function applyMigrationFile(pglite: PGlite): Promise<void> {
  const sql = await readFile(migrationFile, "utf8");

  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

// The pre-0059 subset the backfill reads and writes: work_meta WITHOUT `origin`, plus the provenance,
// ownership, and content edges its classification and owner-seeding depend on.
async function createPreMigrationSchema(pglite: PGlite): Promise<void> {
  await pglite.exec(`
    CREATE TABLE entries (id text PRIMARY KEY, type text NOT NULL);
    CREATE TABLE authors (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE work_meta (
      author_id text NOT NULL REFERENCES authors(id),
      entry_id text PRIMARY KEY REFERENCES entries(id),
      language text NOT NULL,
      title text NOT NULL,
      work_type text NOT NULL
    );
    CREATE TABLE work_sources (
      id text PRIMARY KEY,
      kind text NOT NULL,
      sha256 text NOT NULL,
      work_entry_id text NOT NULL REFERENCES entries(id)
    );
    CREATE TABLE personal_entries (
      entry_id text PRIMARY KEY REFERENCES entries(id),
      user_id text NOT NULL,
      occurred_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE reading_units (
      entry_id text PRIMARY KEY REFERENCES entries(id),
      order_index integer NOT NULL,
      work_entry_id text NOT NULL REFERENCES entries(id)
    );
    INSERT INTO authors (id, name) VALUES ('author-1', 'Author');
  `);
}

async function seedWork(pglite: PGlite, entryId: string): Promise<void> {
  await pglite.exec(`INSERT INTO entries (id, type) VALUES ('${entryId}', 'work');`);
  await pglite.exec(
    `INSERT INTO work_meta (entry_id, author_id, language, title, work_type)
     VALUES ('${entryId}', 'author-1', 'en', '${entryId}', 'book');`
  );
}

async function addSource(
  pglite: PGlite,
  workEntryId: string,
  kind: "manual" | "upload"
): Promise<void> {
  await pglite.exec(
    `INSERT INTO work_sources (id, kind, sha256, work_entry_id)
     VALUES ('src-${workEntryId}-${kind}', '${kind}', 'sha-${workEntryId}', '${workEntryId}');`
  );
}

async function addOwner(pglite: PGlite, entryId: string, userId: string): Promise<void> {
  await pglite.exec(
    `INSERT INTO personal_entries (entry_id, user_id, occurred_at, created_at, updated_at)
     VALUES ('${entryId}', '${userId}', now(), now(), now());`
  );
}

async function addContent(pglite: PGlite, workEntryId: string): Promise<void> {
  const unitId = `${workEntryId}-unit`;
  await pglite.exec(`INSERT INTO entries (id, type) VALUES ('${unitId}', 'reading_unit');`);
  await pglite.exec(
    `INSERT INTO reading_units (entry_id, order_index, work_entry_id)
     VALUES ('${unitId}', 0, '${workEntryId}');`
  );
}

async function origins(pglite: PGlite): Promise<Map<string, string | null>> {
  const rows = await pglite.query<{ entry_id: string; origin: string | null }>(
    "SELECT entry_id, origin FROM work_meta ORDER BY entry_id"
  );
  return new Map(rows.rows.map((row) => [row.entry_id, row.origin]));
}

async function ownerIds(pglite: PGlite): Promise<Map<string, string>> {
  const rows = await pglite.query<{ entry_id: string; user_id: string }>(
    "SELECT entry_id, user_id FROM personal_entries ORDER BY entry_id"
  );
  return new Map(rows.rows.map((row) => [row.entry_id, row.user_id]));
}

describe("0059 explicit Work origin migration", () => {
  it("classifies every recoverable shape, seeds manual ownership once, and preserves content", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);

    // manual source, no owner → 'manual' + a freshly seeded v0 owner facet.
    await seedWork(pglite, "manual-work");
    await addSource(pglite, "manual-work", "manual");
    await addContent(pglite, "manual-work");

    // manual source that already owns a facet → 'manual', existing owner untouched (not duplicated).
    await seedWork(pglite, "manual-owned");
    await addSource(pglite, "manual-owned", "manual");
    await addOwner(pglite, "manual-owned", "someone-else");

    // upload source → 'imported', never seeded an owner.
    await seedWork(pglite, "imported-work");
    await addSource(pglite, "imported-work", "upload");
    await addContent(pglite, "imported-work");

    // owner facet, no source → learner-'authored'.
    await seedWork(pglite, "authored-work");
    await addOwner(pglite, "authored-work", DEFAULT_USER_ID);
    await addContent(pglite, "authored-work");

    // empty shell (no source, no owner, no content) → recovered as 'manual' + seeded owner.
    await seedWork(pglite, "empty-shell");

    await applyMigrationFile(pglite);

    const resolved = await origins(pglite);
    expect(resolved.get("manual-work")).toBe("manual");
    expect(resolved.get("manual-owned")).toBe("manual");
    expect(resolved.get("imported-work")).toBe("imported");
    expect(resolved.get("authored-work")).toBe("authored");
    expect(resolved.get("empty-shell")).toBe("manual");

    // Only the two manual Works that lacked an owner get a freshly-seeded v0 facet; the pre-existing
    // owner is preserved verbatim and imported/authored ownership is untouched.
    const owners = await ownerIds(pglite);
    expect(owners.get("manual-work")).toBe(DEFAULT_USER_ID);
    expect(owners.get("empty-shell")).toBe(DEFAULT_USER_ID);
    expect(owners.get("manual-owned")).toBe("someone-else");
    expect(owners.get("authored-work")).toBe(DEFAULT_USER_ID);
    expect(owners.has("imported-work")).toBe(false);

    // Content is preserved byte-for-byte (no reading unit dropped or added).
    const units = await pglite.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM reading_units"
    );
    expect(units.rows[0]?.count).toBe(3);

    // The column is now NOT NULL and CHECK-guarded: an unknown origin is rejected.
    await expect(
      pglite.exec(
        `INSERT INTO entries (id, type) VALUES ('bad', 'work');
         INSERT INTO work_meta (entry_id, author_id, language, title, work_type, origin)
         VALUES ('bad', 'author-1', 'en', 'Bad', 'book', 'generated');`
      )
    ).rejects.toThrow();
  });

  it("aborts atomically on a Work with both a manual and an upload source", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);

    // A recoverable manual Work processed before the ambiguous one — its owner seed must roll back too.
    await seedWork(pglite, "manual-work");
    await addSource(pglite, "manual-work", "manual");

    await seedWork(pglite, "conflict-work");
    await addSource(pglite, "conflict-work", "manual");
    await addSource(pglite, "conflict-work", "upload");

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/both a manual and an upload source/);

    // The ADD COLUMN committed, but the classifying DO block rolled back atomically: every origin is
    // still NULL, no owner facet was seeded, and SET NOT NULL never ran.
    const resolved = await origins(pglite);
    expect(resolved.get("manual-work")).toBeNull();
    expect(resolved.get("conflict-work")).toBeNull();
    const owners = await ownerIds(pglite);
    expect(owners.size).toBe(0);
  });

  it("aborts on non-empty content that has neither a source nor an owner", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);

    // Content with no provenance and no ownership: its authority cannot be inferred, so refuse to guess.
    await seedWork(pglite, "orphan-content");
    await addContent(pglite, "orphan-content");

    await expect(applyMigrationFile(pglite)).rejects.toThrow(
      /content but neither a source nor an ownership facet/
    );

    const resolved = await origins(pglite);
    expect(resolved.get("orphan-content")).toBeNull();
  });
});
