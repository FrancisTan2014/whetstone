import type { RemapPdfWorkResult } from "./pdfWorkRemap.js";

// Argument parsing, operator reporting, and exit-code mapping for `pnpm pdf:remap` (#861). Kept free of
// database and Node wiring so every arm — including each refusal — is unit-testable; the thin entrypoint
// supplies the real `execute` that opens the database (the same split `data:backup` uses).

export type RemapCliIo = Readonly<{
  err: (line: string) => void;
  out: (line: string) => void;
}>;

const USAGE = "Usage: pnpm pdf:remap -- --work <work-entry-id>";

// A malformed invocation, reported to the operator as a usage error rather than a stack trace.
export class RemapCommandLineError extends Error {}

export function parseRemapArgs(argv: readonly string[]): Readonly<{ workEntryId: string }> {
  if (argv.length !== 2 || argv[0] !== "--work") {
    throw new RemapCommandLineError(`Expected exactly one --work argument. ${USAGE}`);
  }
  const workEntryId = (argv[1] as string).trim();
  if (workEntryId.length === 0) {
    throw new RemapCommandLineError(`--work needs a work entry id. ${USAGE}`);
  }
  return { workEntryId };
}

// Report the outcome and choose the exit code. A refusal is a DELIBERATE outcome, not a crash — but it
// exits non-zero so a script that chains re-maps stops rather than reporting success for a Work that was
// never re-mapped. Each message names the Work and the concrete reason, so an operator can act on it
// without reading the code.
function report(result: RemapPdfWorkResult, io: RemapCliIo): number {
  switch (result.status) {
    case "remapped":
      io.out(`Re-mapped "${result.title}" from its retained converted payload.`);
      io.out(`  reading units: ${result.before.units} -> ${result.after.units}`);
      io.out(`  canonical blocks: ${result.before.blocks} -> ${result.after.blocks}`);
      return 0;
    case "work_not_found":
      io.err("No Work with that entry id.");
      return 1;
    case "not_pdf_imported":
      io.err(
        `"${result.title}" was not published from a PDF import, so it retains no converted payload to re-map from.`
      );
      return 1;
    case "manually_corrected":
      io.err(
        `"${result.title}" was hand-corrected at ${result.correctedAt.toISOString()}; refusing to overwrite a human's corrections.`
      );
      return 1;
    case "no_retained_ranges":
      io.err(
        `"${result.title}" has no retained converted ranges for import attempt ${result.attemptId}, so there is nothing to re-map from.`
      );
      return 1;
    case "mapping_refused":
      io.err(
        `"${result.title}" no longer maps to a publishable document (${result.mappingStatus}); it was left unchanged.`
      );
      return 1;
    // A concurrent writer won the content-revision race, so this re-map wrote nothing.
    default:
      io.err(`"${result.title}" changed while it was being re-mapped; nothing was written.`);
      return 1;
  }
}

export async function runRemapCommand(
  argv: readonly string[],
  execute: (args: Readonly<{ workEntryId: string }>) => Promise<RemapPdfWorkResult>,
  io: RemapCliIo
): Promise<number> {
  try {
    return report(await execute(parseRemapArgs(argv)), io);
  } catch (error) {
    io.err(
      error instanceof RemapCommandLineError
        ? error.message
        : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
    );
    return 1;
  }
}
