// The edge opener's presentation tokens by annotation kind (#555): a quiet hue-modifier class reusing
// the single amber annotation channel (`--color-anno-<kind>`). A static enum->class map only — no
// logic — so it lives here, coverage-excluded, rather than restating the class strings inside tests.
// The block picks a representative kind (a note wins over a mark) and turns it into this class. The
// opener's glyph is a decorative inline SVG (no DOM text) so it never enters the block's rendered-text
// offset model that annotation anchoring depends on.
type NoteKind = "mark" | "note";

// The opener's hue-modifier class for a note or mark.
export function blockOpenerHueClass(kind: NoteKind): string {
  return `readerBlockOpener--${kind}`;
}
