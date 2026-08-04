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

describe("code", () => {
  it("checks listings keep their line structure", () => {
    const dump = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const doc = concatenateRanges(
      { sha256: dump.attempt.source_hash, byteLength: 0, pageCount: dump.attempt.total_pages ?? 0 },
      dump.ranges.map((r: any) => r.payload) as any
    );
    const result = mapStructuredDocument(doc as any);
    if (result.status !== "mapped") throw new Error("status " + result.status);

    let n = 0;
    let withNewline = 0;
    let chars = 0;
    let longestSingleLine = 0;
    const singleLineSamples: string[] = [];

    for (const u of result.units as any[]) {
      for (const b of u.docBlocks as any[]) {
        const node = b.node ?? b.nodeJson ?? b;
        if (node?.type !== "codeBlock") continue;
        const t = text(node);
        n += 1;
        chars += t.length;
        if (t.includes("\n")) withNewline += 1;
        else if (t.length > 60) {
          if (t.length > longestSingleLine) longestSingleLine = t.length;
          if (singleLineSamples.length < 3) singleLineSamples.push(t.slice(0, 150));
        }
      }
    }

    console.log(`\ncodeBlocks=${n}  chars=${chars}`);
    console.log(`with newline   = ${withNewline}  (${((withNewline / n) * 100).toFixed(1)}%)`);
    console.log(`single-line >60 chars, longest = ${longestSingleLine}`);
    for (const s of singleLineSamples) console.log(`   ${JSON.stringify(s)}`);

    // Print one real listing verbatim so a human can judge it.
    for (const u of result.units as any[]) {
      for (const b of u.docBlocks as any[]) {
        const node = b.node ?? b.nodeJson ?? b;
        if (node?.type !== "codeBlock") continue;
        const t = text(node);
        if (t.length > 300) {
          console.log(`\n----- VERBATIM LISTING (${t.length} chars) -----`);
          console.log(t.slice(0, 700));
          console.log(`----- END -----`);
          return;
        }
      }
    }
  }, 600_000);
});
