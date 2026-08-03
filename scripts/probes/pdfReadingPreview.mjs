// Render what the Reader would actually show for one PDF page range.
//
// The aggregate harness (pdfUsabilityHarness.mjs) deliberately prints no text, so it can prove a ratio
// but never that a page READS correctly. This probe answers the complementary question a screenshot
// asks: does the canonical mapping produce a sane heading spine, no running heads, no bare folios, and
// intact code blocks? It drives the same pinned worker and the SAME `mapStructuredDocument` the product
// uses, then prints the resulting blocks as text.
//
// Manual diagnostic only — never part of `pnpm validate`, and it prints book text, so keep its output
// out of PRs and issues.
//
// Usage:
//   node --import tsx scripts/probes/pdfReadingPreview.mjs "<file.pdf>" <startPage> <endPage> [--json out.json]

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKER = "src/apps/server/src/files/pdf_to_docling.py";
const [pdfPath, startArg, endArg, ...rest] = process.argv.slice(2);
if (!pdfPath || !startArg || !endArg) {
  console.error('usage: pdfReadingPreview.mjs "<file.pdf>" <startPage> <endPage> [--json out.json]');
  process.exit(2);
}
const jsonFlag = rest.indexOf("--json");
const jsonOut = jsonFlag === -1 ? null : rest[jsonFlag + 1];

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const artifactDir = mkdtempSync(join(tmpdir(), "whetstone-preview-"));
try {
  const run = spawnSync(
    "python",
    [WORKER, "--range", pdfPath, startArg, endArg, artifactDir],
    { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, WHETSTONE_PDF_MEMORY_MIB: "6144" } }
  );
  if (run.status !== 0) {
    console.error(`worker exit ${run.status}\n${(run.stderr ?? "").slice(0, 4000)}`);
    process.exit(1);
  }

  const contracts = await import("../../src/packages/contracts/src/index.js");
  const mapper = await import("../../src/apps/server/src/features/pdfImport/pdfCanonicalMapping.js");

  const parsed = contracts.parseRangeConversion(run.stdout);
  if (rest.includes("--raw")) {
    const raw = JSON.parse(run.stdout);
    const perPage = new Map();
    for (const item of raw.body ?? []) {
      const key = `${item.pageNumber}`;
      if (!perPage.has(key)) perPage.set(key, []);
      perPage.get(key).push(`${item.label}:${JSON.stringify((item.text ?? "").slice(0, 40))}`);
    }
    for (const [page, items] of [...perPage].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      console.log(`\n-- raw page ${page} --`);
      for (const line of items) console.log(`   ${line}`);
    }
  }
  if (parsed.status !== "ok") {
    console.error(`payload rejected: ${JSON.stringify(parsed).slice(0, 2000)}`);
    process.exit(1);
  }
  const document = contracts.concatenateRanges(
    { byteLength: statSync(pdfPath).size, pageCount: Number(endArg) - Number(startArg) + 1, sha256: sha256(pdfPath) },
    [parsed.value]
  );
  const mapping = mapper.mapStructuredDocument(document);

  if (!Array.isArray(mapping.units)) {
    console.log(`STATUS ${mapping.status}`);
    process.exit(0);
  }

  const text = (node) => {
    if (typeof node?.attrs?.html === "string") return node.attrs.html;
    if (typeof node?.text === "string") return node.text;
    if (!Array.isArray(node?.content)) return "";
    return node.content.map(text).join("");
  };

  const dump = { status: mapping.status, units: [] };
  console.log(`STATUS ${mapping.status}   units=${mapping.units.length}`);
  for (const unit of mapping.units) {
    const u = { title: unit.title ?? unit.label ?? "(untitled)", blocks: [] };
    console.log(`\n${"=".repeat(78)}\nUNIT: ${u.title}\n${"=".repeat(78)}`);
    for (const block of unit.docBlocks) {
      const node = block.node;
      const kind = node.type === "heading" ? `H${node.attrs?.level ?? "?"}` : node.type;
      const body = text(node).replace(/\s+/g, " ").trim();
      u.blocks.push({ kind, text: body });
      console.log(`[${kind.padEnd(11)}] ${body.slice(0, 150)}`);
    }
    dump.units.push(u);
  }

  const excluded = mapping.excludedFurniture ?? [];
  console.log(`\n--- excluded furniture: ${excluded.length} ---`);
  for (const item of excluded.slice(0, 40))
    console.log(`  (${item.rule ?? "?"}) ${String(item.text ?? "").replace(/\s+/g, " ").slice(0, 90)}`);

  if (jsonOut) {
    dump.excludedFurniture = excluded;
    writeFileSync(jsonOut, JSON.stringify(dump, null, 2), "utf-8");
    console.log(`\nwrote ${jsonOut}`);
  }
} finally {
  rmSync(artifactDir, { force: true, recursive: true });
}
