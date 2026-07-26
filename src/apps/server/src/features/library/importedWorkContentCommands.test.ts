import { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { toEntryId, type EntryId } from "@whetstone/domain";
import { type DocumentNodeJSON } from "@whetstone/document";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import {
  authors,
  blocks,
  docBlocks,
  entries,
  readingUnits,
  uploadedSourceClaims,
  workMeta,
  workSources
} from "../../db/schema.js";
import {
  initializeEditableWorkContent,
  reconcileEditableWorkContent
} from "../content/editableWorkContent.js";
import {
  addImportedWorkSection,
  correctImportedWorkContent,
  type ImportedWorkContentDependencies
} from "./importedWorkContentCommands.js";

// #762 imported-Work correction command behavior, exercised against a real database. These prove the
// authority is different from the manual editor's (no owner / no `personal_entries`): eligibility is the
// sole gate, the Work-revision fence (#703) protects concurrent saves, and each edit shape stamps exactly
// the right durable correction markers. Provenance rows are never touched, and surviving block ids are
// preserved so notes / positions / cards anchored to them stay valid.

let db: DbClient;
let pglite: PGlite;
let sequence = 0;
let clock: Date;

const createEntryId = (): string => `new-${(sequence += 1)}`;

function dependencies(): ImportedWorkContentDependencies {
  return { createEntryId, db, now: () => clock };
}

function para(text: string, id: string): DocumentNodeJSON {
  return { attrs: { id }, content: [{ text, type: "text" }], type: "paragraph" };
}

function heading(text: string, id: string): DocumentNodeJSON {
  return { attrs: { id, level: 1 }, content: [{ text, type: "text" }], type: "heading" };
}

function doc(...nodes: ReadonlyArray<DocumentNodeJSON>): DocumentNodeJSON {
  return { content: [...nodes], type: "doc" };
}

// A canonical imported Work (origin=imported, fully doc_blocks) with one section holding a heading and a
// paragraph. Returns its ids so a test can target the exact blocks by their preserved attrs.id.
async function seedCanonicalImported(
  entryId: string
): Promise<{ headingId: string; paraId: string; unitEntryId: string; workEntryId: EntryId }> {
  await db.insert(authors).values({ id: `author-${entryId}`, name: entryId, nameKey: entryId });
  await db.insert(entries).values({ id: entryId, type: "work" });
  await db.insert(workMeta).values({
    authorId: `author-${entryId}`,
    entryId,
    language: "en",
    origin: "imported",
    title: `Work ${entryId}`,
    workType: "book"
  });
  const { unitEntryId } = await db.transaction((tx) =>
    initializeEditableWorkContent(tx, { createEntryId, workEntryId: toEntryId(entryId) })
  );
  const headingId = `${entryId}-h1`;
  const paraId = `${entryId}-p1`;
  await db.transaction((tx) =>
    reconcileEditableWorkContent(tx, {
      document: doc(heading("Chapter", headingId), para("Body", paraId)),
      unitEntryId,
      workEntryId: toEntryId(entryId)
    })
  );
  return { headingId, paraId, unitEntryId, workEntryId: toEntryId(entryId) };
}

async function seedManualWork(entryId: string): Promise<string> {
  await db.insert(authors).values({ id: `author-${entryId}`, name: entryId, nameKey: entryId });
  await db.insert(entries).values({ id: entryId, type: "work" });
  await db.insert(workMeta).values({
    authorId: `author-${entryId}`,
    entryId,
    language: "en",
    origin: "manual",
    title: `Manual ${entryId}`,
    workType: "book"
  });
  const { unitEntryId } = await db.transaction((tx) =>
    initializeEditableWorkContent(tx, { createEntryId, workEntryId: toEntryId(entryId) })
  );
  await db.transaction((tx) =>
    reconcileEditableWorkContent(tx, {
      document: doc(para("Manual body", `${entryId}-p1`)),
      unitEntryId,
      workEntryId: toEntryId(entryId)
    })
  );
  return unitEntryId;
}

// A Markdown-only imported Work: legacy `blocks` on a unit with no doc_blocks — not canonical, so not
// correctable.
async function seedMarkdownImported(entryId: string): Promise<void> {
  await db.insert(authors).values({ id: `author-${entryId}`, name: entryId, nameKey: entryId });
  await db.insert(entries).values({ id: entryId, type: "work" });
  await db.insert(workMeta).values({
    authorId: `author-${entryId}`,
    entryId,
    language: "en",
    origin: "imported",
    title: `Markdown ${entryId}`,
    workType: "book"
  });
  const unitId = `${entryId}-unit`;
  const blockId = `${entryId}-legacy`;
  await db.insert(entries).values([
    { id: unitId, type: "reading_unit" },
    { id: blockId, type: "block" }
  ]);
  await db.insert(readingUnits).values({
    entryId: unitId,
    orderIndex: 0,
    sourceFile: null,
    title: null,
    workEntryId: entryId
  });
  await db.insert(blocks).values({
    blockType: "paragraph",
    deletedAt: null,
    entryId: blockId,
    mdastJson: { type: "paragraph" },
    orderIndex: 0,
    plaintext: "legacy",
    readingUnitEntryId: unitId,
    workEntryId: entryId
  });
}

async function revisionOf(workEntryId: string): Promise<number> {
  const [row] = await db
    .select({ contentRevision: workMeta.contentRevision })
    .from(workMeta)
    .where(eq(workMeta.entryId, workEntryId));
  return row?.contentRevision ?? -1;
}

async function workMarker(workEntryId: string): Promise<Date | null> {
  const [row] = await db
    .select({ manualCorrectionsAt: workMeta.manualCorrectionsAt })
    .from(workMeta)
    .where(eq(workMeta.entryId, workEntryId));
  return row?.manualCorrectionsAt ?? null;
}

async function blockMarkers(
  workEntryId: string
): Promise<Array<{ correctedAt: Date | null; id: string }>> {
  return db
    .select({ correctedAt: docBlocks.correctedAt, id: docBlocks.id })
    .from(docBlocks)
    .where(eq(docBlocks.workEntryId, workEntryId))
    .orderBy(asc(docBlocks.orderIndex));
}

async function blockIds(workEntryId: string): Promise<string[]> {
  const rows = await blockMarkers(workEntryId);
  return rows.map((row) => row.id);
}

beforeEach(async () => {
  sequence = 0;
  clock = new Date("2026-07-01T10:00:00.000Z");
  pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
});

afterEach(async () => {
  await pglite.close();
});

describe("correctImportedWorkContent — authorization", () => {
  it("rejects an unknown Work id with not_found", async () => {
    const result = await correctImportedWorkContent(
      dependencies(),
      toEntryId("nope"),
      toEntryId("nope-unit"),
      doc(para("x", "x")),
      0
    );

    expect(result.status).toBe("not_found");
  });

  it("rejects a manual Work through the imported gate", async () => {
    const unitEntryId = await seedManualWork("manual-1");

    const result = await correctImportedWorkContent(
      dependencies(),
      toEntryId("manual-1"),
      toEntryId(unitEntryId),
      doc(para("edited", "manual-1-p1")),
      0
    );

    expect(result.status).toBe("not_found");
    expect(await workMarker("manual-1")).toBeNull();
  });

  it("rejects a Markdown-only imported Work (not canonical)", async () => {
    await seedMarkdownImported("md-1");

    const result = await correctImportedWorkContent(
      dependencies(),
      toEntryId("md-1"),
      toEntryId("md-1-unit"),
      doc(para("edited", "p")),
      0
    );

    expect(result.status).toBe("not_found");
  });

  it("rejects a section that belongs to another Work", async () => {
    const { workEntryId } = await seedCanonicalImported("host-1");
    const other = await seedCanonicalImported("other-1");

    const result = await correctImportedWorkContent(
      dependencies(),
      workEntryId,
      toEntryId(other.unitEntryId),
      doc(para("edited", "x")),
      0
    );

    expect(result.status).toBe("not_found");
  });
});

describe("correctImportedWorkContent — save semantics and markers", () => {
  it("corrects a block, preserving surviving ids and stamping only the changed block", async () => {
    const { headingId, paraId, unitEntryId, workEntryId } = await seedCanonicalImported("c-1");

    const result = await correctImportedWorkContent(
      dependencies(),
      workEntryId,
      toEntryId(unitEntryId),
      doc(heading("Chapter", headingId), para("Corrected body", paraId)),
      0
    );

    expect(result.status).toBe("corrected");
    if (result.status !== "corrected") {
      return;
    }
    expect(result.work.revision).toBe(1);
    expect(result.work.correctedAt).toBe(clock.toISOString());
    // Surviving block ids are preserved so anchors stay valid.
    expect(await blockIds(workEntryId)).toEqual([headingId, paraId]);
    expect(await workMarker(workEntryId)).toEqual(clock);
    // Only the edited paragraph carries a per-block marker; the untouched heading stays null.
    expect(await blockMarkers(workEntryId)).toEqual([
      { correctedAt: null, id: headingId },
      { correctedAt: clock, id: paraId }
    ]);
  });

  it("stamps a newly inserted block on a correction", async () => {
    const { headingId, paraId, unitEntryId, workEntryId } = await seedCanonicalImported("c-2");

    const result = await correctImportedWorkContent(
      dependencies(),
      workEntryId,
      toEntryId(unitEntryId),
      doc(heading("Chapter", headingId), para("Body", paraId), para("Added", "")),
      0
    );

    expect(result.status).toBe("corrected");
    expect(await workMarker(workEntryId)).toEqual(clock);
    const markers = await blockMarkers(workEntryId);
    // The heading and unchanged body stay null; the appended block (a fresh id) is stamped.
    expect(markers.filter((row) => row.correctedAt !== null)).toHaveLength(1);
    const stamped = markers.find((row) => row.correctedAt !== null);
    expect(stamped).toBeDefined();
    // The stamped block is the newly inserted one, not either preserved block.
    expect([headingId, paraId]).not.toContain(stamped?.id);
  });

  it("advances the revision but stamps no marker on a no-op save", async () => {
    const { headingId, paraId, unitEntryId, workEntryId } = await seedCanonicalImported("c-3");

    const result = await correctImportedWorkContent(
      dependencies(),
      workEntryId,
      toEntryId(unitEntryId),
      doc(heading("Chapter", headingId), para("Body", paraId)),
      0
    );

    expect(result.status).toBe("corrected");
    if (result.status !== "corrected") {
      return;
    }
    expect(result.work.revision).toBe(1);
    expect(result.work.correctedAt).toBeNull();
    expect(await workMarker(workEntryId)).toBeNull();
    expect(await blockMarkers(workEntryId)).toEqual([
      { correctedAt: null, id: headingId },
      { correctedAt: null, id: paraId }
    ]);
  });

  it("keeps the first-correction instant across a later correction", async () => {
    const { headingId, paraId, unitEntryId, workEntryId } = await seedCanonicalImported("c-4");
    const deps = dependencies();

    await correctImportedWorkContent(
      deps,
      workEntryId,
      toEntryId(unitEntryId),
      doc(heading("Chapter", headingId), para("First edit", paraId)),
      0
    );
    const first = clock;
    clock = new Date("2026-08-01T10:00:00.000Z");
    await correctImportedWorkContent(
      deps,
      workEntryId,
      toEntryId(unitEntryId),
      doc(heading("Chapter edited", headingId), para("First edit", paraId)),
      1
    );

    // The Work marker records the earliest correction and is never moved forward.
    expect(await workMarker(workEntryId)).toEqual(first);
  });

  it("refuses a stale revision as a conflict and writes nothing", async () => {
    const { headingId, paraId, unitEntryId, workEntryId } = await seedCanonicalImported("c-5");

    const result = await correctImportedWorkContent(
      dependencies(),
      workEntryId,
      toEntryId(unitEntryId),
      doc(heading("Chapter", headingId), para("Should not persist", paraId)),
      99
    );

    expect(result.status).toBe("conflict");
    expect(await revisionOf(workEntryId)).toBe(0);
    expect(await workMarker(workEntryId)).toBeNull();
    // The original body text survives untouched.
    const [body] = await db
      .select({ plaintext: docBlocks.plaintext })
      .from(docBlocks)
      .where(eq(docBlocks.id, paraId));
    expect(body?.plaintext).toBe("Body");
  });

  it("never touches immutable source provenance on a correction", async () => {
    const { headingId, paraId, unitEntryId, workEntryId } = await seedCanonicalImported("c-6");
    await db.insert(workSources).values({
      fileName: "book.pdf",
      filePath: "/vault/book.pdf",
      id: "source-1",
      kind: "upload",
      sha256: "abc123",
      sourceText: null,
      workEntryId
    });
    await db.insert(uploadedSourceClaims).values({ sha256: "abc123", workEntryId });

    await correctImportedWorkContent(
      dependencies(),
      workEntryId,
      toEntryId(unitEntryId),
      doc(heading("Chapter", headingId), para("Corrected", paraId)),
      0
    );

    const [source] = await db.select().from(workSources).where(eq(workSources.id, "source-1"));
    expect(source).toMatchObject({ sha256: "abc123", workEntryId });
    const [claim] = await db
      .select()
      .from(uploadedSourceClaims)
      .where(eq(uploadedSourceClaims.sha256, "abc123"));
    expect(claim).toMatchObject({ sha256: "abc123", workEntryId });
  });
});

describe("addImportedWorkSection", () => {
  it("appends a section, opens it, and stamps the new blocks", async () => {
    const { workEntryId } = await seedCanonicalImported("a-1");

    const result = await addImportedWorkSection(dependencies(), workEntryId, 0);

    expect(result.status).toBe("added");
    if (result.status !== "added") {
      return;
    }
    expect(result.work.revision).toBe(1);
    expect(result.work.sections).toHaveLength(2);
    // The Work opens at the freshly added section.
    expect(result.work.sections.at(-1)?.unitEntryId).toBe(result.work.unitEntryId);
    expect(await workMarker(workEntryId)).toEqual(clock);
    // Every block of the new section is stamped as inserted; the original section stays untouched.
    const markers = await blockMarkers(workEntryId);
    const stamped = markers.filter((row) => row.correctedAt !== null);
    expect(stamped.length).toBeGreaterThan(0);
    for (const row of stamped) {
      expect(row.correctedAt).toEqual(clock);
    }
  });

  it("rejects a non-correctable Work with not_found", async () => {
    await seedMarkdownImported("a-2");

    const result = await addImportedWorkSection(dependencies(), toEntryId("a-2"), 0);

    expect(result.status).toBe("not_found");
  });

  it("refuses a stale revision as a conflict and writes nothing", async () => {
    const { workEntryId } = await seedCanonicalImported("a-3");
    const before = await blockIds(workEntryId);

    const result = await addImportedWorkSection(dependencies(), workEntryId, 42);

    expect(result.status).toBe("conflict");
    expect(await revisionOf(workEntryId)).toBe(0);
    expect(await blockIds(workEntryId)).toEqual(before);
  });
});
