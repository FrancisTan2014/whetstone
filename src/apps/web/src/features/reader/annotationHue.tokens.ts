// Maps a note template to its annotation hue (Vocabulary amber, Expression teal-green, Thought
// violet). Unknown templates fall back to the vocabulary hue. The hue carries the note's meaning;
// callers turn the key into the underline-span class (`noteMark--<hue>`) or the whole-block gutter
// class (`readerBlock--<hue>`).
type AnnotationHue = "expr" | "thought" | "vocab";

const hueByTemplate: Readonly<Record<string, AnnotationHue>> = {
  expression: "expr",
  thought: "thought",
  vocabulary: "vocab"
};

export function annotationHueKey(templateId: string): AnnotationHue {
  return hueByTemplate[templateId] ?? "vocab";
}

// The underline-span hue class for a sub-block note in the given template's colour.
export function noteMarkHueClass(templateId: string): string {
  return `noteMark--${annotationHueKey(templateId)}`;
}

// The whole-block gutter-bar hue class for a note with no sub-block offsets.
export function blockGutterHueClass(templateId: string): string {
  return `readerBlock--${annotationHueKey(templateId)}`;
}
