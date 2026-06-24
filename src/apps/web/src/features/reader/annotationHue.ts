// Maps a note template to its annotation-hue token class so a highlighted block is
// tinted with the template's colour (Vocabulary amber, Expression teal-green, Thought
// violet). Unknown templates fall back to the vocabulary hue.
const hueByTemplate: Readonly<Record<string, string>> = {
  expression: "readerBlock--expr",
  thought: "readerBlock--thought",
  vocabulary: "readerBlock--vocab"
};

export function annotationHueClass(templateId: string): string {
  return hueByTemplate[templateId] ?? "readerBlock--vocab";
}
