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

describe("typography", () => {
  it("counts reader-visible text-join defects book-wide", () => {
    const dump = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const doc = concatenateRanges(
      { sha256: dump.attempt.source_hash, byteLength: 0, pageCount: dump.attempt.total_pages ?? 0 },
      dump.ranges.map((r: any) => r.payload) as any
    );
    const result = mapStructuredDocument(doc as any);
    if (result.status !== "mapped") throw new Error("status " + result.status);

    // Only prose the reader reads as sentences. Code keeps its own spacing rules.
    const PROSE = new Set(["paragraph", "heading", "bulletList", "orderedList", "blockquote"]);

    const pats: Record<string, RegExp> = {
      "broken contraction (it' s)": /[a-z][\u2019'] (?:s|t|d|ll|re|ve|m)\b/gi,
      "space before . , ; :": / +(?=[.,;:])/g,
      "space before ? !": / +(?=[?!])/g,
      "space inside open paren": /\( +/g,
      "double space (COLLAPSED by browser)": /\S {2,}\S/g,
      "hyphen line-join (auto- matic)": /[a-z]- [a-z]/g,
    };

    const counts: Record<string, number> = {};
    const samples: Record<string, string[]> = {};
    let proseChars = 0;
    let proseBlocks = 0;

    for (const u of result.units as any[]) {
      for (const b of u.docBlocks as any[]) {
        const node = b.node ?? b.nodeJson ?? b;
        if (!PROSE.has(node?.type)) continue;
        const t = text(node);
        proseChars += t.length;
        proseBlocks += 1;
        for (const [name, re] of Object.entries(pats)) {
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(t)) !== null) {
            counts[name] = (counts[name] ?? 0) + 1;
            if ((samples[name] ??= []).length < 4) {
              samples[name]!.push(JSON.stringify(t.slice(Math.max(0, m.index - 22), m.index + 24)));
            }
            if (m.index === re.lastIndex) re.lastIndex++;
          }
        }
      }
    }

    console.log(`\nprose blocks=${proseBlocks}  prose chars=${proseChars}\n`);
    for (const name of Object.keys(pats)) {
      const n = counts[name] ?? 0;
      const per = ((n / proseChars) * 10000).toFixed(2);
      console.log(`${String(n).padStart(6)}  (${per} per 10k chars)  ${name}`);
      for (const s of samples[name] ?? []) console.log(`            ${s}`);
    }
  }, 600_000);
});


