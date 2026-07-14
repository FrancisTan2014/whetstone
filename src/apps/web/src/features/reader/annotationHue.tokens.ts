// One muted amber annotation channel for every rich note, plus a lighter variant for a bodyless Mark
// (#619). The channel carries only the note/mark distinction — never the note's content — so editing a
// note never changes its colour. Callers turn the kind into the underline-span class
// (`noteMark--<kind>`) or the whole-block gutter class (`readerBlock--<kind>`).
type NoteKind = "mark" | "note";

// The underline-span hue class for a sub-block note or mark.
export function noteMarkHueClass(kind: NoteKind): string {
  return `noteMark--${kind}`;
}

// The whole-block gutter-bar hue class for a note or mark with no sub-block offsets.
export function blockGutterHueClass(kind: NoteKind): string {
  return `readerBlock--${kind}`;
}
