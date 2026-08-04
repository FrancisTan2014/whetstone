import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { concatenateRanges } from "@whetstone/contracts";
import { mapStructuredDocument } from "./src/features/pdfImport/pdfCanonicalMapping.js";

const FIXTURE = process.env.REMAP_FIXTURE ?? "Q:\\src\\whetstone\\artifacts\\remap\\cleancode-ranges.json";
const UNIT = Number(process.env.RQ_UNIT ?? "3");
const LIMIT = Number(process.env.RQ_LIMIT ?? "70");

describe("reading quality harness", () => {
  it("dumps a chapter as the Reader would show it", () => {
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
    const collectText = (n: any): string => {
      if (!n || typeof n !== "object") return "";
      let s = typeof n.text === "string" ? n.text : "";
      if (Array.isArray(n.content)) for (const c of n.content) s += collectText(c);
      return s;
    };
    const u = result.units[UNIT];
    console.log(`=== UNIT ${UNIT}: ${JSON.stringify(u.title)}  (${u.docBlocks.length} blocks) ===`);
    u.docBlocks.slice(0, LIMIT).forEach((b: any, i: number) => {
      const node = b.node ?? b.nodeJson ?? b;
      const ty = b.type ?? node?.type ?? "?";
      const lvl = node?.attrs?.level != null ? `h${node.attrs.level}` : "";
      const t = collectText(node).replace(/\s+/g, " ").trim();
      console.log(`${String(i).padStart(3)} [${ty}${lvl ? " " + lvl : ""}] ${JSON.stringify(t.slice(0, 160))}`);
    });
  });
});
