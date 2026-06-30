// Pure presentational enum→tag/class maps for the read-only PM document renderer (PmDocument.tsx,
// #312). These hold no rendering logic — only a static lookup — so the renderer stays the single
// behavioral surface under test; this module is excluded from coverage by the repo's `*.tokens.ts`
// convention (see vitest.config.ts).

export type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

const headingTags: readonly HeadingTag[] = ["h1", "h2", "h3", "h4", "h5", "h6"];

// Resolve a heading `level` attr to its semantic tag, clamping to the 1–6 range HTML allows so a
// malformed/out-of-range level degrades to the nearest valid heading rather than an invalid element.
export function headingTag(level: unknown): HeadingTag {
  const raw = typeof level === "number" && Number.isInteger(level) ? level : 1;
  const clamped = Math.min(6, Math.max(1, raw));
  return headingTags[clamped - 1] ?? "h1";
}

// The set of admonition kinds we give a dedicated tonal class; any other (or absent) kind renders as
// the base callout surface. Day/Night is carried by the theme CSS variables these classes read.
const calloutKindClasses: Readonly<Record<string, string>> = {
  caution: "readerCallout--caution",
  important: "readerCallout--important",
  note: "readerCallout--note",
  tip: "readerCallout--tip",
  warning: "readerCallout--warning"
};

// The modifier class for a callout's kind, or undefined when the kind is unset/unrecognized.
export function calloutKindClass(kind: unknown): string | undefined {
  return typeof kind === "string" ? calloutKindClasses[kind] : undefined;
}
