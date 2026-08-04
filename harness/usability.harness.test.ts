import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { concatenateRanges } from "@whetstone/contracts";
import { mapStructuredDocument } from "./src/features/pdfImport/pdfCanonicalMapping.js";

const FIXTURE = process.env.REMAP_FIXTURE ?? "Q:\\src\\whetstone\\artifacts\\remap\\cleancode-ranges.json";

const collectText = (n: any): string => {
  if (!n || typeof n !== "object") return "";
  let s = typeof n.text === "string" ? n.text : "";
  if (Array.isArray(n.content)) for (const c of n.content) s += collectText(c);
  return s;
};

describe("usability harness", () => {
  it("scores every unit as the reader would show it", () => {
    const dump = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const ranges = dump.ranges.map((r: any) => r.payload);
    const doc = concatenateRanges(
      { sha256: dump.attempt.source_hash, byteLength: 0, pageCount: dump.attempt.total_pages ?? 0 },
      ranges as any
    );
    const result = mapStructuredDocument(doc as any);
    if (result.status !== "mapped") {
      console.log("STATUS:", result.status);
      return;
    }

    console.log("unit | blocks | empty | empty% | tiny(<3ch) | medianLen | chars | title");
    let totalBlocks = 0;
    let totalEmpty = 0;
    let totalTiny = 0;
    let totalChars = 0;
    const suspect: string[] = [];

    result.units.forEach((u, i) => {
      const lens = u.docBlocks.map((b: any) => collectText(b.node ?? b.nodeJson ?? b).trim().length);
      const blocks = lens.length;
      const empty = lens.filter((l) => l === 0).length;
      const tiny = lens.filter((l) => l > 0 && l < 3).length;
      const chars = lens.reduce((a, b) => a + b, 0);
      const sorted = [...lens].sort((a, b) => a - b);
      const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
      const pct = blocks ? Math.round((empty / blocks) * 100) : 0;
      totalBlocks += blocks;
      totalEmpty += empty;
      totalTiny += tiny;
      totalChars += chars;
      console.log(
        `${String(i).padStart(3)} | ${String(blocks).padStart(5)} | ${String(empty).padStart(5)} | ${String(pct).padStart(5)}% | ${String(tiny).padStart(9)} | ${String(median).padStart(8)} | ${String(chars).padStart(6)} | ${u.title}`
      );
      if (pct >= 20 || (blocks > 20 && median < 3)) suspect.push(`${i}: ${u.title} (${empty}/${blocks} empty, median ${median})`);
    });

    console.log("=== WHOLE BOOK ===");
    console.log("units:", result.units.length);
    console.log("blocks:", totalBlocks);
    console.log("empty blocks:", totalEmpty, `(${Math.round((totalEmpty / totalBlocks) * 100)}%)`);
    console.log("tiny blocks (<3 chars):", totalTiny);
    console.log("chars:", totalChars);
    console.log("=== SUSPECT UNITS (>=20% empty, or long unit of tiny blocks) ===");
    if (suspect.length === 0) console.log("(none)");
    suspect.forEach((s) => console.log(" ", s));
  });
});
