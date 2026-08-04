import { describe, expect, it } from "vitest";

import type { RemapPdfWorkResult } from "./pdfWorkRemap.js";
import {
  parseRemapArgs,
  RemapCommandLineError,
  runRemapCommand
} from "./pdfWorkRemapCommandLine.js";

function collect() {
  const err: string[] = [];
  const out: string[] = [];
  return {
    err,
    io: {
      err: (line: string) => {
        err.push(line);
      },
      out: (line: string) => {
        out.push(line);
      }
    },
    out
  };
}

async function run(result: RemapPdfWorkResult) {
  const sink = collect();
  const code = await runRemapCommand(["--work", "work-1"], async () => result, sink.io);
  return { code, err: sink.err, out: sink.out };
}

describe("parseRemapArgs", () => {
  it("reads the work entry id and trims it", () => {
    expect(parseRemapArgs(["--work", "  work-1  "])).toEqual({ workEntryId: "work-1" });
  });

  it.each([
    ["no arguments", []],
    ["a missing value", ["--work"]],
    ["an unknown flag", ["--force", "work-1"]],
    ["extra arguments", ["--work", "work-1", "--force"]]
  ])("rejects %s with the usage line", (_case, argv) => {
    expect(() => parseRemapArgs(argv)).toThrow(RemapCommandLineError);
    expect(() => parseRemapArgs(argv)).toThrow("pnpm pdf:remap");
  });

  it("rejects a blank work entry id", () => {
    expect(() => parseRemapArgs(["--work", "   "])).toThrow("needs a work entry id");
  });
});

describe("runRemapCommand", () => {
  it("reports the before/after counts of a successful re-map and succeeds", async () => {
    const { code, err, out } = await run({
      after: { blocks: 3800, units: 240 },
      before: { blocks: 4267, units: 525 },
      status: "remapped",
      title: "Clean Code"
    });

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual([
      'Re-mapped "Clean Code" from its retained converted payload.',
      "  reading units: 525 -> 240",
      "  canonical blocks: 4267 -> 3800"
    ]);
  });

  // Every refusal is a deliberate outcome, but it exits non-zero: a chained script must stop rather than
  // report success for a Work that was never re-mapped. Each message names the specific reason.
  it.each([
    [{ status: "work_not_found" } as const, "No Work with that entry id."],
    [
      { status: "not_pdf_imported", title: "Hand-written" } as const,
      "not published from a PDF import"
    ],
    [
      {
        correctedAt: new Date("2026-03-03T04:05:06.000Z"),
        status: "manually_corrected",
        title: "Clean Code"
      } as const,
      "hand-corrected at 2026-03-03T04:05:06.000Z"
    ],
    [
      { attemptId: "att-9", status: "no_retained_ranges", title: "Clean Code" } as const,
      "no retained converted ranges for import attempt att-9"
    ],
    [
      {
        mappingStatus: "ocr_validation_failed",
        status: "mapping_refused",
        title: "Clean Code"
      } as const,
      "(ocr_validation_failed); it was left unchanged"
    ],
    [{ status: "conflict", title: "Clean Code" } as const, "changed while it was being re-mapped"]
  ])("reports the %# refusal on stderr and exits non-zero", async (result, expected) => {
    const { code, err, out } = await run(result);

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain(expected);
  });

  it("reports a usage error without running the command", async () => {
    const sink = collect();
    let ran = false;

    const code = await runRemapCommand(
      ["--work"],
      async () => {
        ran = true;
        throw new Error("unreachable");
      },
      sink.io
    );

    expect(code).toBe(1);
    expect(ran).toBe(false);
    expect(sink.err[0]).toContain("Expected exactly one --work argument.");
  });

  it("reports an unexpected failure as an error rather than crashing", async () => {
    const sink = collect();

    const code = await runRemapCommand(
      ["--work", "work-1"],
      async () => {
        throw new Error("database is unavailable");
      },
      sink.io
    );

    expect(code).toBe(1);
    expect(sink.err).toEqual(["Unexpected error: database is unavailable"]);
  });

  it("reports a non-Error failure without losing its message", async () => {
    const sink = collect();

    const code = await runRemapCommand(
      ["--work", "work-1"],
      async () => Promise.reject("boom"),
      sink.io
    );

    expect(code).toBe(1);
    expect(sink.err).toEqual(["Unexpected error: boom"]);
  });
});
