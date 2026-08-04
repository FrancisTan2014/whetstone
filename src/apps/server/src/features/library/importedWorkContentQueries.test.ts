import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { toEntryId, type EntryId } from "@whetstone/domain";
import { type DocumentNodeJSON } from "@whetstone/document";

import { createDbClient, type DbClient } from "../../db/dbClient.js";
import { runMigrations } from "../../db/migrate.js";
import { authors, blocks, entries, readingUnits, workMeta } from "../../db/schema.js";
import {
  initializeEditableWorkContent,
  reconcileEditableWorkContent
} from "../content/editableWorkContent.js";
import {
  findCorrectableImportedWork,
  loadImportedWorkForCorrection,
  loadImportedWorkUnit
} from "./importedWorkContentQueries.js";
import { listWorks } from "./libraryQueries.js";

// #762 canonical-content eligibility for imported correction. An imported Work is correctable only when
// its COMPLETE readable hierarchy is canonical `doc_blocks` — every unit renders from `doc_blocks`, none
// from legacy mdast. These tests seed each real shape (PDF doc-only, EPUB dual-write, Markdown legacy-only,
// mixed, soft-deleted/detached legacy) against a real database and prove the predicate classifies each.

let db: DbClient;
let pglite: PGlite;
let sequence = 0;
const createEntryId = (): string => `unit-${(sequence += 1)}`;

function para(text: string, id: string): DocumentNodeJSON {
  return { attrs: { id }, content: [{ text, type: "text" }], type: "paragraph" };
}

function doc(...nodes: ReadonlyArray<DocumentNodeJSON>): DocumentNodeJSON {
  return { content: [...nodes], type: "doc" };
}

// A canonical imported Work: `origin = imported` with one reading unit whose content is canonical
// `doc_blocks` (the shape a PDF import produces). Returns the Work and its first unit's id.
async function seedCanonicalImported(
  entryId: string
): Promise<{ unitEntryId: string; workEntryId: EntryId }> {
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
  await db.transaction((tx) =>
    reconcileEditableWorkContent(tx, {
      document: doc(para("Imported body", `${entryId}-b1`)),
      unitEntryId,
      workEntryId: toEntryId(entryId)
    })
  );
  return { unitEntryId, workEntryId: toEntryId(entryId) };
}

// Attach a legacy `blocks` row to a unit, emulating an EPUB dual-write (unit also has `doc_blocks`) or a
// Markdown-only unit (unit has no `doc_blocks`). `deletedAt`/`readingUnitEntryId` model the soft-deleted
// and detached cases that must NOT block eligibility.
async function seedLegacyBlock(
  workEntryId: string,
  options: Readonly<{ deletedAt?: Date; readingUnitEntryId: string | null }>
): Promise<void> {
  const id = `legacy-block-${(sequence += 1)}`;
  await db.insert(entries).values({ id, type: "block" });
  await db.insert(blocks).values({
    blockType: "paragraph",
    deletedAt: options.deletedAt ?? null,
    entryId: id,
    mdastJson: { type: "paragraph" },
    orderIndex: 0,
    plaintext: "legacy",
    readingUnitEntryId: options.readingUnitEntryId,
    workEntryId
  });
}

// A unit with a legacy `blocks` row and NO `doc_blocks` — a Markdown-only reading unit.
async function seedLegacyOnlyUnit(workEntryId: string): Promise<void> {
  const unitId = createEntryId();
  await db.insert(entries).values({ id: unitId, type: "reading_unit" });
  await db.insert(readingUnits).values({
    entryId: unitId,
    orderIndex: 1,
    sourceFile: null,
    title: null,
    workEntryId
  });
  await seedLegacyBlock(workEntryId, { readingUnitEntryId: unitId });
}

beforeEach(async () => {
  sequence = 0;
  pglite = new PGlite();
  await runMigrations(pglite);
  db = createDbClient(pglite);
});

afterEach(async () => {
  await pglite.close();
});

describe("findCorrectableImportedWork — eligibility", () => {
  it("treats a fully canonical imported Work (PDF-style, doc_blocks only) as correctable", async () => {
    const { workEntryId } = await seedCanonicalImported("pdf-1");

    const work = await findCorrectableImportedWork(db, workEntryId);

    expect(work).toBeDefined();
    expect(work?.title).toBe("Work pdf-1");
    expect(work?.manualCorrectionsAt).toBeNull();
  });

  it("treats an EPUB-style dual-write (doc_blocks plus a legacy row on the same unit) as correctable", async () => {
    const { unitEntryId, workEntryId } = await seedCanonicalImported("epub-1");
    await seedLegacyBlock("epub-1", { readingUnitEntryId: unitEntryId });

    expect(await findCorrectableImportedWork(db, workEntryId)).toBeDefined();
  });

  it("refuses an imported Work with any Markdown-only unit (legacy blocks, no doc_blocks)", async () => {
    const { workEntryId } = await seedCanonicalImported("mixed-1");
    await seedLegacyOnlyUnit("mixed-1");

    expect(await findCorrectableImportedWork(db, workEntryId)).toBeUndefined();
  });

  it("refuses a purely legacy imported Work with no doc_blocks at all", async () => {
    await db.insert(authors).values({ id: "author-md", name: "md", nameKey: "md" });
    await db.insert(entries).values({ id: "md-1", type: "work" });
    await db.insert(workMeta).values({
      authorId: "author-md",
      entryId: "md-1",
      language: "en",
      origin: "imported",
      title: "Markdown only",
      workType: "book"
    });
    await seedLegacyOnlyUnit("md-1");

    expect(await findCorrectableImportedWork(db, toEntryId("md-1"))).toBeUndefined();
  });

  it("ignores a soft-deleted or detached legacy block when judging eligibility", async () => {
    const { workEntryId } = await seedCanonicalImported("evidence-1");
    // A soft-deleted legacy row on its own (doc-block-less) unit does not render, so it does not block.
    const deletedUnit = createEntryId();
    await db.insert(entries).values({ id: deletedUnit, type: "reading_unit" });
    await db.insert(readingUnits).values({
      entryId: deletedUnit,
      orderIndex: 1,
      sourceFile: null,
      title: null,
      workEntryId: "evidence-1"
    });
    await seedLegacyBlock("evidence-1", {
      deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      readingUnitEntryId: deletedUnit
    });
    // A detached legacy row (no reading unit) likewise does not render.
    await seedLegacyBlock("evidence-1", { readingUnitEntryId: null });

    expect(await findCorrectableImportedWork(db, workEntryId)).toBeDefined();
  });

  it("refuses a manual Work through the imported gate", async () => {
    await db.insert(authors).values({ id: "author-m", name: "m", nameKey: "m" });
    await db.insert(entries).values({ id: "manual-1", type: "work" });
    await db.insert(workMeta).values({
      authorId: "author-m",
      entryId: "manual-1",
      language: "en",
      origin: "manual",
      title: "Manual",
      workType: "book"
    });
    const { unitEntryId } = await db.transaction((tx) =>
      initializeEditableWorkContent(tx, { createEntryId, workEntryId: toEntryId("manual-1") })
    );
    await db.transaction((tx) =>
      reconcileEditableWorkContent(tx, {
        document: doc(para("Manual body", "m-b1")),
        unitEntryId,
        workEntryId: toEntryId("manual-1")
      })
    );

    expect(await findCorrectableImportedWork(db, toEntryId("manual-1"))).toBeUndefined();
  });

  it("returns undefined for an unknown id", async () => {
    expect(await findCorrectableImportedWork(db, toEntryId("nope"))).toBeUndefined();
  });
});

describe("loadImportedWorkForCorrection / loadImportedWorkUnit", () => {
  it("opens a correctable imported Work at its first section with the section list", async () => {
    const { unitEntryId, workEntryId } = await seedCanonicalImported("open-1");

    const dto = await loadImportedWorkForCorrection(db, workEntryId);

    expect(dto).toBeDefined();
    expect(dto?.entryId).toBe("open-1");
    expect(dto?.unitEntryId).toBe(unitEntryId);
    expect(dto?.correctedAt).toBeNull();
    expect(dto?.revision).toBe(0);
    expect(dto?.sections).toHaveLength(1);
    expect(dto?.document.content?.[0]?.type).toBe("paragraph");
  });

  it("returns undefined opening a non-correctable Work", async () => {
    await db.insert(authors).values({ id: "author-x", name: "x", nameKey: "x" });
    await db.insert(entries).values({ id: "legacy-work", type: "work" });
    await db.insert(workMeta).values({
      authorId: "author-x",
      entryId: "legacy-work",
      language: "en",
      origin: "imported",
      title: "Legacy",
      workType: "book"
    });
    await seedLegacyOnlyUnit("legacy-work");

    expect(await loadImportedWorkForCorrection(db, toEntryId("legacy-work"))).toBeUndefined();
  });

  it("loads a specific section's document on demand", async () => {
    const { unitEntryId, workEntryId } = await seedCanonicalImported("unit-load");

    const unit = await loadImportedWorkUnit(db, workEntryId, toEntryId(unitEntryId));

    expect(unit).toBeDefined();
    expect(unit?.unitEntryId).toBe(unitEntryId);
    expect(unit?.document.content).toHaveLength(1);
  });

  it("returns undefined for a cross-work or unknown unit id", async () => {
    const { workEntryId } = await seedCanonicalImported("unit-guard");

    expect(await loadImportedWorkUnit(db, workEntryId, toEntryId("foreign-unit"))).toBeUndefined();
  });

  it("returns undefined loading a unit of a non-correctable Work", async () => {
    await db.insert(authors).values({ id: "author-y", name: "y", nameKey: "y" });
    await db.insert(entries).values({ id: "legacy-2", type: "work" });
    await db.insert(workMeta).values({
      authorId: "author-y",
      entryId: "legacy-2",
      language: "en",
      origin: "imported",
      title: "Legacy 2",
      workType: "book"
    });
    await seedLegacyOnlyUnit("legacy-2");

    expect(
      await loadImportedWorkUnit(db, toEntryId("legacy-2"), toEntryId("whatever"))
    ).toBeUndefined();
  });
});

describe("listWorks — correctable projection", () => {
  it("marks a canonical imported Work correctable and everything else not", async () => {
    await seedCanonicalImported("canonical");
    // A manual Work is owner-authored, never a shared-content correction target.
    await db.insert(authors).values({ id: "author-man", name: "man", nameKey: "man" });
    await db.insert(entries).values({ id: "manual", type: "work" });
    await db.insert(workMeta).values({
      authorId: "author-man",
      entryId: "manual",
      language: "en",
      origin: "manual",
      title: "Manual",
      workType: "book"
    });
    const { unitEntryId } = await db.transaction((tx) =>
      initializeEditableWorkContent(tx, { createEntryId, workEntryId: toEntryId("manual") })
    );
    await db.transaction((tx) =>
      reconcileEditableWorkContent(tx, {
        document: doc(para("Manual body", "manual-b1")),
        unitEntryId,
        workEntryId: toEntryId("manual")
      })
    );
    // A Markdown-only imported Work still renders from legacy mdast, so it is not correctable.
    await db.insert(authors).values({ id: "author-md", name: "md", nameKey: "md" });
    await db.insert(entries).values({ id: "markdown", type: "work" });
    await db.insert(workMeta).values({
      authorId: "author-md",
      entryId: "markdown",
      language: "en",
      origin: "imported",
      title: "Markdown",
      workType: "book"
    });
    await seedLegacyOnlyUnit("markdown");

    const { works } = await listWorks(db);
    const byId = new Map(works.map((item) => [item.work.entryId, item.correctable]));

    expect(byId.get(toEntryId("canonical"))).toBe(true);
    expect(byId.get(toEntryId("manual"))).toBe(false);
    expect(byId.get(toEntryId("markdown"))).toBe(false);
  });
});
