import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { concatenateRanges } from "@whetstone/contracts";
import { mapStructuredDocument } from "./src/features/pdfImport/pdfCanonicalMapping.js";

const FIXTURE = process.env.REMAP_FIXTURE ?? "Q:\\src\\whetstone\\artifacts\\remap\\cleancode-ranges.json";

describe("remap harness", () => {
  it("maps the real converted document", () => {
    const dump = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const ranges = dump.ranges.map((r: any) => r.payload);
    const doc = concatenateRanges(
      { sha256: dump.attempt.source_hash, byteLength: 0, pageCount: dump.attempt.total_pages ?? 0 },
      ranges as any
    );
    const result = mapStructuredDocument(doc as any);
    if (result.status !== "mapped") {
      console.log("STATUS:", result.status, JSON.stringify(result));
      return;
    }
    const units = result.units;
    const blocks = units.reduce((n, u) => n + u.docBlocks.length, 0);
    let chars = 0;
    const typeCounts: Record<string, number> = {};
    const collectText = (n: any): string => {
      if (!n || typeof n !== "object") return "";
      let s = typeof n.text === "string" ? n.text : "";
      if (Array.isArray(n.content)) for (const c of n.content) s += collectText(c);
      return s;
    };
    let allText = "";
    for (const u of units) {
      for (const b of u.docBlocks) {
        const node = (b as any).node ?? (b as any).nodeJson ?? b;
        const t = collectText(node);
        chars += t.length;
        allText += t + "\n";
        const ty = (b as any).type ?? node?.type ?? "?";
        typeCounts[ty] = (typeCounts[ty] ?? 0) + 1;
      }
    }
    const norm = allText.replace(/\s+/g, "");
    console.log("TEXT chars (raw):", chars, " normalized(no-ws):", norm.length);
    console.log("=== REMAP RESULT ===");
    console.log("units:", units.length);
    console.log("blocks:", blocks);
    console.log("headingLevelSources:", JSON.stringify(result.headingLevelSources));
    console.log("unmappedLabels:", JSON.stringify(result.unmappedLabels));
    console.log("excludedFurniture:", result.excludedFurnitureCount, "chars", result.excludedFurnitureCharacters);
    console.log("unresolvedFigures:", result.unresolvedFigureCount);
    console.log("block types:", JSON.stringify(typeCounts));
    console.log("--- unit titles (first 60) ---");
    units.slice(0, 60).forEach((u, i) => {
      console.log(
        `${String(i).padStart(3)}  blocks=${String(u.docBlocks.length).padStart(4)}  ${JSON.stringify(u.title)}`
      );
    });
    if (units.length > 60) console.log(`... ${units.length - 60} more units`);
    const sizes = units.map((u) => u.docBlocks.length).sort((a, b) => a - b);
    console.log(
      "unit block-count: min",
      sizes[0],
      "median",
      sizes[Math.floor(sizes.length / 2)],
      "max",
      sizes[sizes.length - 1]
    );
  });
});
