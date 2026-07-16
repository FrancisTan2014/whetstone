// One muted amber annotation channel for every rich note, plus a lighter variant for a bodyless Mark
// (#619). The channel carries only the note/mark distinction — never the note's content — so editing a
// note never changes its colour. Callers turn the kind into the inline underline-span class
// (`noteMark--<kind>`); the underline itself is the annotation's direct activation target (#644).
type NoteKind = "mark" | "note";

// The underline-span hue class for a sub-block note or mark.
export function noteMarkHueClass(kind: NoteKind): string {
  return `noteMark--${kind}`;
}
