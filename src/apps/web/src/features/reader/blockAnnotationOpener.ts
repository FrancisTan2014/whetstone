import type { AnchoredNoteDto } from "@whetstone/contracts";

// Pure routing for a block's single edge opener (#555). An annotated block shows ONE always-visible
// >=44px opener instead of turning each inline underline into a tap target; these helpers decide what
// that opener says and does from the block's annotations alone (no DOM, no React), so the behaviour is
// unit-tested in isolation. A single rich note opens straight into its editor; a lone bodyless Mark or
// any multi-annotation block opens the block chooser so the reader picks the right one.

// The opener's accessible name. A lone annotation names its kind and its anchored text so a screen
// reader announces exactly what opens; several annotations announce the count for the passage.
export function blockOpenerLabel(notes: ReadonlyArray<AnchoredNoteDto>): string {
  if (notes.length !== 1) {
    return `Open ${notes.length} annotations in this passage`;
  }

  const [only] = notes;

  /* v8 ignore next 4 -- `notes.length === 1` guarantees a first element; this only narrows the type
     for the compiler and is never taken at runtime. */
  if (only === undefined) {
    return "";
  }

  const kindWord = only.kind === "mark" ? "mark" : "note";

  return `Open ${kindWord} on '${only.anchor.selectedTextSnapshot}'`;
}

// What the opener does when activated: open one note's editor directly, or open the block chooser.
export type BlockOpenerAction =
  | Readonly<{ kind: "note"; note: AnchoredNoteDto }>
  | Readonly<{ kind: "chooser" }>;

// Route the opener: a single rich note opens its editor; everything else (a lone bodyless Mark, or
// more than one annotation) opens the chooser so the reader targets the right annotation.
export function blockOpenerAction(notes: ReadonlyArray<AnchoredNoteDto>): BlockOpenerAction {
  if (notes.length !== 1) {
    return { kind: "chooser" };
  }

  const [only] = notes;

  /* v8 ignore next 4 -- `notes.length === 1` guarantees a first element; this only narrows the type
     for the compiler and is never taken at runtime. */
  if (only === undefined) {
    return { kind: "chooser" };
  }

  return only.kind === "note" ? { kind: "note", note: only } : { kind: "chooser" };
}
