import type { CaptureSource, MemoryStateTone } from "./memoryLabels";

// Presentational token maps for the Memory surface: the capture-source badge tint and the
// jargon-free state chip tint. Static enum->class maps with no product logic, so — like the other
// `*.tokens` modules (e.g. templateHue.tokens.ts) — they are excluded from coverage. The rendered
// label text they sit beside is the tested part; these only decide the tint.

// The badge tint for how a fragment was captured. Learner-added memories get the accent tint so a
// hand-kept fragment reads as the primary case; every derived source shares a calm neutral tint.
export function captureSourceBadgeClass(source: CaptureSource): string {
  switch (source) {
    case "manual":
      return "bg-accent/10 text-accent";
    default:
      return "bg-bg text-text-muted";
  }
}

// The state chip tint: due draws the eye (accent), scheduled is settled neutral, draft is muted.
export function memoryStateChipClass(tone: MemoryStateTone): string {
  switch (tone) {
    case "due":
      return "bg-accent/10 text-accent";
    case "scheduled":
      return "bg-bg text-text";
    default:
      return "bg-bg text-text-muted";
  }
}
