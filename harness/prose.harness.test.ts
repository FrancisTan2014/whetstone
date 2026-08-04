import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { concatenateRanges } from "@whetstone/contracts";
import { mapStructuredDocument } from "./src/features/pdfImport/pdfCanonicalMapping.js";

const FIXTURE = process.env.REMAP_FIXTURE ?? "Q:\\src\\whetstone\\artifacts\\remap\\cleancode-ranges.json";

const text = (n: any): string => {
  if (!n || typeof n !== "object") return "";
  let s = typeof n.text === "string" ? n.text : "";
  if (Array.isArray(n.content)) for (const c of n.content) s += text(c);
  return s;
};

describe("prose", () => {
  it("prints a unit as the reader would show it", () => {
    const dump = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const doc = concatenateRanges(
      { sha256: dump.attempt.source_hash, byteLength: 0, pageCount: dump.attempt.total_pages ?? 0 },
      dump.ranges.map((r: any) => r.payload) as any
    );
    const result = mapStructuredDocument(doc as any);
    if (result.status !== "mapped") throw new Error("status " + result.status);

    const want = process.env.WT_UNIT ?? "Meaningful Names";
    const u = (result.units as any[]).find((x) => (x.title ?? "").includes(want)) ?? result.units[3]!;
    console.log(`\n##### ${JSON.stringify((u as any).title)}  blocks=${u.docBlocks.length}\n`);

    let printed = 0;
    const cap = Number(process.env.WT_CHARS ?? 3000);
    for (const b of u.docBlocks as any[]) {
      const node = b.node ?? b.nodeJson ?? b;
      const t = text(node).replace(/\s+/g, " ").trim();
      console.log(`[${node?.type ?? "?"}] ${t}`);
      printed += t.length;
      if (printed > cap) break;
    }
  }, 600_000);
});
