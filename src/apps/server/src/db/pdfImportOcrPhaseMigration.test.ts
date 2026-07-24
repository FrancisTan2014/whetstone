import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "./migrate.js";

// PDF import OCR phase migrations. 0069/0070 (#745) extend the #721/#702 PDF import tables:
// `pdf_import_attempts` gains `phase` and `ocr_fingerprint`; `pdf_import_publications` swaps the old
// `ocr_required_pages` dead-end column for two typed text-less outcome columns and widens `result_ck`;
// `pdf_block_evidence` gains additive `ocr_engine`/`ocr_language` provenance. 0071 (#746) then enables
// Chinese OCR: it persists the resolved `ocr_language` on each attempt (CHECK in en/zh-CN/zh-TW) and
// retires the now-unreachable `ocr_language_not_enabled_pages` refusal column, narrowing `result_ck`
// to four mutually-exclusive outcomes. These tests apply the full migration chain and prove those
// invariants directly.

async function insertAttempt(pglite: PGlite, id: string, phase = "NULL"): Promise<void> {
  const phaseValue = phase === "NULL" ? "NULL" : `'${phase}'`;
  // `converted` is terminal and unconstrained by the single-running partial index, so a test can seed
  // several attempts to hang publications off of.
  await pglite.exec(
    `INSERT INTO pdf_import_attempts (id, user_id, source_hash, state, phase)
     VALUES ('${id}', 'user-1', 'sha', 'converted', ${phaseValue});`
  );
}

type PublicationFields = Readonly<{
  workEntryId?: string;
  ocrValidationFailedPages?: number;
  noContent?: boolean;
  unpreservableImages?: number;
}>;

async function insertPublication(
  pglite: PGlite,
  attemptId: string,
  fields: PublicationFields = {}
): Promise<void> {
  const workEntryId = fields.workEntryId === undefined ? "NULL" : `'${fields.workEntryId}'`;
  const validationPages =
    fields.ocrValidationFailedPages === undefined ? "NULL" : `${fields.ocrValidationFailedPages}`;
  const noContent = fields.noContent === undefined ? "NULL" : `${fields.noContent}`;
  const images =
    fields.unpreservableImages === undefined ? "NULL" : `${fields.unpreservableImages}`;
  await pglite.exec(
    `INSERT INTO pdf_import_publications
       (attempt_id, file_name, work_entry_id,
        ocr_validation_failed_pages, no_content, unpreservable_images)
     VALUES ('${attemptId}', 'book.pdf', ${workEntryId}, ${validationPages}, ${noContent}, ${images});`
  );
}

async function columnExists(pglite: PGlite, table: string, column: string): Promise<boolean> {
  const rows = await pglite.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_name = '${table}' AND column_name = '${column}';`
  );
  return (rows.rows[0]?.count ?? 0) > 0;
}

describe("PDF import OCR phase migrations", () => {
  let pglite: PGlite;

  beforeEach(async () => {
    pglite = new PGlite();
    await runMigrations(pglite);
  });

  it("adds the durable phase and OCR fingerprint columns to attempts", async () => {
    expect(await columnExists(pglite, "pdf_import_attempts", "phase")).toBe(true);
    expect(await columnExists(pglite, "pdf_import_attempts", "ocr_fingerprint")).toBe(true);
    await insertAttempt(pglite, "a1", "ocr");
    await pglite.exec(
      "UPDATE pdf_import_attempts SET ocr_fingerprint = 'ocrmypdf-16:eng' WHERE id = 'a1';"
    );
    const rows = await pglite.query<{ phase: string; ocr_fingerprint: string }>(
      "SELECT phase, ocr_fingerprint FROM pdf_import_attempts WHERE id = 'a1';"
    );
    expect(rows.rows[0]?.phase).toBe("ocr");
    expect(rows.rows[0]?.ocr_fingerprint).toBe("ocrmypdf-16:eng");
  });

  it("persists the resolved OCR language on attempts, defaulting to English and bounded to the three Work languages", async () => {
    expect(await columnExists(pglite, "pdf_import_attempts", "ocr_language")).toBe(true);
    await insertAttempt(pglite, "lang-default");
    const defaulted = await pglite.query<{ ocr_language: string }>(
      "SELECT ocr_language FROM pdf_import_attempts WHERE id = 'lang-default';"
    );
    expect(defaulted.rows[0]?.ocr_language).toBe("en");
    await pglite.exec(
      "UPDATE pdf_import_attempts SET ocr_language = 'zh-CN' WHERE id = 'lang-default';"
    );
    const updated = await pglite.query<{ ocr_language: string }>(
      "SELECT ocr_language FROM pdf_import_attempts WHERE id = 'lang-default';"
    );
    expect(updated.rows[0]?.ocr_language).toBe("zh-CN");
    await expect(
      pglite.exec(
        "UPDATE pdf_import_attempts SET ocr_language = 'fr' WHERE id = 'lang-default';"
      )
    ).rejects.toThrow();
  });

  it("replaces the ocr_required_pages dead end and retires the not-enabled refusal column", async () => {
    expect(await columnExists(pglite, "pdf_import_publications", "ocr_required_pages")).toBe(false);
    expect(
      await columnExists(pglite, "pdf_import_publications", "ocr_language_not_enabled_pages")
    ).toBe(false);
    expect(
      await columnExists(pglite, "pdf_import_publications", "ocr_validation_failed_pages")
    ).toBe(true);
  });

  it("permits at most one publication outcome", async () => {
    await insertAttempt(pglite, "two");
    await expect(
      insertPublication(pglite, "two", {
        ocrValidationFailedPages: 3,
        noContent: true
      })
    ).rejects.toThrow();
    // A single typed outcome, or none (pending), is allowed.
    await insertAttempt(pglite, "three");
    await insertPublication(pglite, "three", { ocrValidationFailedPages: 4 });
    await insertAttempt(pglite, "four");
    await insertPublication(pglite, "four");
  });

  it("requires the text-less validation page count to be positive", async () => {
    await insertAttempt(pglite, "validation-zero");
    await expect(
      insertPublication(pglite, "validation-zero", { ocrValidationFailedPages: 0 })
    ).rejects.toThrow();
  });

  it("adds additive OCR provenance columns to block evidence", async () => {
    expect(await columnExists(pglite, "pdf_block_evidence", "ocr_engine")).toBe(true);
    expect(await columnExists(pglite, "pdf_block_evidence", "ocr_language")).toBe(true);
  });
});
