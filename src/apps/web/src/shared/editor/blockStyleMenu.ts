import type { Editor } from "@tiptap/core";

// The one current-style menu the Work toolbar shows in place of separate Paragraph/H1/H2/H3/Quote/Code
// buttons (#791). Each entry is a shared block-command id (see `blockCommands`) plus the human label the
// menu presents, in the order the menu lists them: Text, the three headings, Quote, then Code block.
export type BlockStyleOption = Readonly<{ id: string; label: string }>;

export const blockStyleOptions: readonly BlockStyleOption[] = [
  { id: "paragraph", label: "Text" },
  { id: "heading-1", label: "Heading 1" },
  { id: "heading-2", label: "Heading 2" },
  { id: "heading-3", label: "Heading 3" },
  { id: "blockquote", label: "Quote" },
  { id: "code-block", label: "Code block" }
];

// The option that names the block type the selection currently sits in, so the trigger reads the live
// structure at a glance and the menu marks the active entry. Headings resolve by level; a blockquote and a
// code block name themselves; every other textblock (paragraphs, list items) reads as plain Text — the
// same default the slash catalog treats as "paragraph".
export function currentBlockStyle(editor: Editor): BlockStyleOption {
  if (editor.isActive("heading", { level: 1 })) {
    return blockStyleOptions[1]!;
  }
  if (editor.isActive("heading", { level: 2 })) {
    return blockStyleOptions[2]!;
  }
  if (editor.isActive("heading", { level: 3 })) {
    return blockStyleOptions[3]!;
  }
  if (editor.isActive("blockquote")) {
    return blockStyleOptions[4]!;
  }
  if (editor.isActive("codeBlock")) {
    return blockStyleOptions[5]!;
  }
  return blockStyleOptions[0]!;
}
