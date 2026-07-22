import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  concatenateRanges,
  flattenDocItems,
  parseRangeConversion,
  validateStructuredDocument
} from "@whetstone/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  createFakePdfStructuredAdapter,
  issueStagedFileHandle,
  type StagedFileHandle
} from "./pdfStructuredAdapter.js";

// Synthetic fixtures (#701 validation): each is a representative worker `--range` payload for one
// structural case. They prove the contract validates and the adapter assembles each structure without
// dropping anything — never a real PDF or model.
function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./tests/fixtures/structured/${name}.json`, import.meta.url)),
    "utf-8"
  );
}

const cleanupDirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function stageFile(bytes: Uint8Array): Promise<StagedFileHandle> {
  const stageRoot = await mkdtemp(join(tmpdir(), "whetstone-fixture-stage-"));
  cleanupDirs.push(stageRoot);
  await writeFile(join(stageRoot, "staged.pdf"), bytes);
  return issueStagedFileHandle(stageRoot, "staged.pdf");
}

function labelsIn(items: readonly { label: string }[]): string[] {
  return items.map((item) => item.label);
}

const STRUCTURAL_FIXTURES = [
  "columns",
  "headings",
  "tables",
  "figures",
  "formulas",
  "punctuation",
  "low_confidence"
];

describe("structured PDF fixtures — contract validation", () => {
  it.each(STRUCTURAL_FIXTURES)("parses and validates the %s fixture", (name) => {
    const parsed = parseRangeConversion(fixture(name));
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") throw new Error("expected ok");
    const document = concatenateRanges(
      { sha256: "a".repeat(64), byteLength: 1234, pageCount: 1 },
      [parsed.value]
    );
    expect(validateStructuredDocument(document).ok).toBe(true);
  });

  it("preserves two-column reading order as distinct items", () => {
    const parsed = parseRangeConversion(fixture("columns"));
    if (parsed.status !== "ok") throw new Error("expected ok");
    expect(parsed.value.body.map((item) => item.text)).toEqual([
      "Left column paragraph.",
      "Right column paragraph."
    ]);
    // Distinct geometry keeps the two columns separable evidence, never merged.
    expect(parsed.value.body[0]!.boundingBox.right).toBeLessThan(
      parsed.value.body[1]!.boundingBox.left
    );
  });

  it("keeps headings, body, and running-head furniture in their trees", () => {
    const parsed = parseRangeConversion(fixture("headings"));
    if (parsed.status !== "ok") throw new Error("expected ok");
    expect(labelsIn(parsed.value.body)).toEqual(["section_header", "text"]);
    expect(labelsIn(parsed.value.furniture)).toEqual(["page_header"]);
  });

  it("preserves nested table structure down to the cells", () => {
    const parsed = parseRangeConversion(fixture("tables"));
    if (parsed.status !== "ok") throw new Error("expected ok");
    const labels = flattenDocItems(parsed.value.body).map((item) => item.label);
    expect(labels).toEqual(["table", "table_row", "table_cell", "table_cell"]);
    const cellText = flattenDocItems(parsed.value.body)
      .filter((item) => item.label === "table_cell")
      .map((item) => item.text);
    expect(cellText).toEqual(["Term", "Definition"]);
  });

  it("keeps a figure's caption as a child", () => {
    const parsed = parseRangeConversion(fixture("figures"));
    if (parsed.status !== "ok") throw new Error("expected ok");
    expect(parsed.value.body[0]!.label).toBe("picture");
    expect(parsed.value.body[0]!.children[0]!.label).toBe("caption");
    expect(parsed.value.body[0]!.children[0]!.text).toContain("Figure 1");
  });

  it("retains a formula item verbatim", () => {
    const parsed = parseRangeConversion(fixture("formulas"));
    if (parsed.status !== "ok") throw new Error("expected ok");
    expect(parsed.value.body[0]!.label).toBe("formula");
    expect(parsed.value.body[0]!.text).toBe("E = mc^2");
  });

  it("carries CJK / Greek / smart punctuation through unchanged", () => {
    const parsed = parseRangeConversion(fixture("punctuation"));
    if (parsed.status !== "ok") throw new Error("expected ok");
    expect(parsed.value.body[0]!.text).toContain("测试 α β");
    expect(parsed.value.body[0]!.text).toContain("‘smart quotes’");
  });

  it("never drops a low-confidence, unknown-label item", () => {
    const parsed = parseRangeConversion(fixture("low_confidence"));
    if (parsed.status !== "ok") throw new Error("expected ok");
    expect(parsed.value.body).toHaveLength(1);
    expect(parsed.value.body[0]!.label).toBe("some_unknown_label");
    expect(parsed.value.body[0]!.confidence).toBeLessThan(0.5);
  });

  it("classifies a schema-invalid payload as malformed", () => {
    expect(parseRangeConversion(fixture("malformed_schema")).status).toBe("malformed");
  });

  it("classifies a newer docling schema as unsupported_schema", () => {
    const parsed = parseRangeConversion(fixture("unsupported_schema"));
    expect(parsed.status).toBe("unsupported_schema");
    if (parsed.status !== "unsupported_schema") throw new Error("expected unsupported_schema");
    expect(parsed.version).toBe("0.0.9");
  });
});

describe("structured PDF fixtures — through the adapter", () => {
  it("assembles the tables fixture into a validated document via the fake adapter", async () => {
    const handle = await stageFile(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    const adapter = createFakePdfStructuredAdapter({ rangePayloads: [fixture("tables")] });
    const outcome = await adapter.convert(handle);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(validateStructuredDocument(outcome.document).ok).toBe(true);
    const labels = flattenDocItems(outcome.document.body).map((item) => item.label);
    expect(labels).toContain("table_cell");
  });

  it("surfaces an encrypted PDF as a password_required failure", async () => {
    const handle = await stageFile(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    const adapter = createFakePdfStructuredAdapter({ probe: { status: "password_required" } });
    const outcome = await adapter.convert(handle);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.failure.kind).toBe("password_required");
  });
});
