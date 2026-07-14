// The chip swatch for a note card: one muted amber for a rich note, a lighter variant for a bodyless
// Mark (#619). Mirrors the reader annotation channel so a card and its reader highlight read as the
// same colour; the swatch carries only the note/mark distinction, never the note's content.
type NoteKind = "mark" | "note";

export function noteChipSwatchClass(kind: NoteKind): string {
  return `noteCardChip--${kind}`;
}
