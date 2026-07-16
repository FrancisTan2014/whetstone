import type { AnchoredNoteDto } from "@whetstone/contracts";

// Pure activation logic for the reader's inline note underlines (#644), restoring the direct
// annotation↔editor relationship (#555 had routed opening through a block-level edge opener). These
// helpers hold the two pure product decisions — no DOM, no React — so they unit-test in isolation:
// the accessible name an underline announces, and how the note(s) covering an activated position
// resolve to a direct open or (only on genuine overlap) a compact chooser.

type NoteKind = "mark" | "note";

// The accessible name for one inline underline: it names the annotation kind and the anchored text, so
// activating it announces exactly which note it opens.
export function noteMarkLabel(kind: NoteKind, exact: string): string {
  const kindWord = kind === "mark" ? "mark" : "note";

  return `Open ${kindWord} on '${exact}'`;
}

// What activating an underline does, given the note(s) whose ranges cover the activated text.
export type NoteActivation =
  | Readonly<{ kind: "note"; note: AnchoredNoteDto }>
  | Readonly<{ kind: "chooser"; notes: ReadonlyArray<AnchoredNoteDto> }>;

// Resolve the note ids under an activated underline (innermost first) against the loaded notes:
//  - a lone rich note opens its own editor directly;
//  - a lone bodyless Mark, or several genuinely overlapping annotations, open the compact chooser
//    scoped to exactly those annotations (never the whole paragraph);
//  - nothing resolves (a stale/removed id) when no loaded note matches.
// Annotations are disjoint by design (#163), so a single note covers a position in the common case and
// the chooser appears only where notes truly overlap — never merely because a paragraph holds several
// non-overlapping notes.
export function resolveActivatedNotes(
  noteIds: ReadonlyArray<string>,
  notes: ReadonlyArray<AnchoredNoteDto>
): NoteActivation | undefined {
  const matched = noteIds
    .map((id) => notes.find((note) => note.entryId === id))
    .filter((note): note is AnchoredNoteDto => note !== undefined);

  const [first, ...rest] = matched;

  if (first === undefined) {
    return undefined;
  }

  if (rest.length === 0 && first.kind === "note") {
    return { kind: "note", note: first };
  }

  return { kind: "chooser", notes: matched };
}
