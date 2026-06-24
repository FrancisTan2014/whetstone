// Maps a note template to the hue-swatch class used by the selection toolbar and the
// editor's segmented template control. Mirrors the reader block hues (Vocabulary amber,
// Expression teal-green, Thought violet) but as standalone control swatches so the
// controls tint independently of the reader surface. Unknown templates fall back to the
// vocabulary hue.
const swatchByTemplate: Readonly<Record<string, string>> = {
  expression: "templateHue--expr",
  thought: "templateHue--thought",
  vocabulary: "templateHue--vocab"
};

export function templateSwatchClass(templateId: string): string {
  return swatchByTemplate[templateId] ?? "templateHue--vocab";
}
