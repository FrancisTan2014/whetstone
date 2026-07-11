import type { MemoryNoteSummaryDto } from "@whetstone/contracts";

// The learner never sees storage internals — a Memory row reads in plain words. These pure helpers
// turn the DTO's structured counts and capture source into that jargon-free copy; the matching tint
// classes live in `memory.tokens.ts`. Kept out of the components so the wording is unit-testable on
// its own.
export type CaptureSource = MemoryNoteSummaryDto["captureSource"];

export type MemoryStateTone = "draft" | "due" | "scheduled";

// How the fragment came to be kept, phrased for the learner rather than as a provenance enum.
export function captureSourceLabel(source: CaptureSource): string {
  switch (source) {
    case "manual":
      return "Added by you";
    case "reader":
      return "From reading";
    case "import":
      return "Imported";
    case "practice":
      return "From practice";
    case "tool":
      return "From a tool";
  }
}

// "No prompts" / "1 prompt" / "N prompts" — never a bare number, and grammatical at one.
export function promptCountLabel(count: number): string {
  if (count === 0) {
    return "No prompts";
  }
  if (count === 1) {
    return "1 prompt";
  }
  return `${count} prompts`;
}

// The single jargon-free state chip: due now wins, then a scheduled note, otherwise it is still a draft
// awaiting an answer. The `tone` is the design token key the chip tint maps through.
export function memoryState(
  note: Readonly<Pick<MemoryNoteSummaryDto, "dueCount" | "scheduledCount">>
): Readonly<{ label: string; tone: MemoryStateTone }> {
  if (note.dueCount > 0) {
    return { label: `${note.dueCount} due`, tone: "due" };
  }
  if (note.scheduledCount > 0) {
    return { label: "Scheduled", tone: "scheduled" };
  }
  return { label: "Draft", tone: "draft" };
}
