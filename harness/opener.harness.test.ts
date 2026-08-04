import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { concatenateRanges } from "@whetstone/contracts";
import { mapStructuredDocument } from "./src/features/pdfImport/pdfCanonicalMapping.js";

const FIXTURE = process.env.REMAP_FIXTURE ?? "Q:\\src\\whetstone\\artifacts\\remap\\cleancode-ranges.json";

describe("unit opener census", () => {
  it("censuses the first blocks of every unit", () => {
    const dump = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const ranges = dump.ranges.map((r: any) => r.payload);
    const doc = concatenateRanges(
      { sha256: dump.attempt.source_hash, byteLength: 0, pageCount: dump.attempt.total_pages ?? 0 },
      ranges as any
    );
    const result = mapStructuredDocument(doc as any);
    if (result.status !== "mapped") return;
    const text = (n: any): string => {
      if (!n || typeof n !== "object") return "";
      let s = typeof n.text === "string" ? n.text : "";
      if (Array.isArray(n.content)) for (const c of n.content) s += text(c);
      return s;
    };
    let doubled = 0;
    result.units.forEach((u: any, i: number) => {
      const b = u.docBlocks;
      const d = (k: number) => {
        const node = b[k]?.node ?? b[k]?.nodeJson ?? b[k];
        return { ty: b[k]?.type ?? node?.type ?? "-", t: text(node).replace(/\s+/g, " ").trim() };
      };
      const a0 = d(0);
      const a1 = d(1);
      const pair = a0.ty === "heading" && a1.ty === "heading";
      if (pair) doubled += 1;
      console.log(
        `${String(i).padStart(3)} title=${String(JSON.stringify(u.title ?? null)).slice(0, 42).padEnd(44)} b0=[${a0.ty}]${JSON.stringify(a0.t.slice(0, 30))} b1=[${a1.ty}]${JSON.stringify(a1.t.slice(0, 30))}${pair ? "   <-- DOUBLE HEADING" : ""}`
      );
    });
    console.log("units with two consecutive opening headings:", doubled, "of", result.units.length);
  });
});
