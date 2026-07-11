import type { ChainedCommands, Editor } from "@tiptap/core";

// The single shared block-command catalog. Every editor interaction surface — the slash menu now,
// a future block/drag menu later (#588) — turns the current block into another block type through
// these commands instead of re-deriving Tiptap transactions. A command is pure data plus two thin
// seams over Tiptap: `appendTo` composes its transform onto a caller-owned chain (so the caller can
// prepend focus, delete a slash query, etc. and keep one undo step), and `isAvailable` answers
// whether the surface should offer it in the current selection. Only v0 document-schema block types
// appear here.

export interface BlockCommand {
  /** Stable id for selection wiring, tests, and later block-menu reuse. */
  readonly id: string;
  /** Human label shown in a menu and matched during filtering. */
  readonly label: string;
  /** Extra search terms matched during filtering, none of them shown. */
  readonly aliases: readonly string[];
  /** Appends this command's block transform onto a caller-owned Tiptap chain. */
  readonly appendTo: (chain: ChainedCommands) => ChainedCommands;
  /** True when the surface should offer this command for the current selection. */
  readonly isAvailable: (editor: Editor) => boolean;
}

interface BlockCommandDefinition {
  readonly id: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly appendTo: (chain: ChainedCommands) => ChainedCommands;
}

// These "turn the current block into X" commands apply wherever prose is edited: any textblock except
// a code block, where a slash types verbatim and block styling is meaningless. A `can()`-based check
// is deliberately NOT used for availability because converting a paragraph to a paragraph is a no-op
// that `can()` reports as inapplicable — that would wrongly hide Text from the menu in a paragraph.
function isBlockTransformContext(editor: Editor): boolean {
  const parent = editor.state.selection.$from.parent;
  return parent.isTextblock && parent.type.name !== "codeBlock";
}

function defineCommand(definition: BlockCommandDefinition): BlockCommand {
  return { ...definition, isAvailable: isBlockTransformContext };
}

export const blockCommands: readonly BlockCommand[] = [
  defineCommand({
    aliases: ["paragraph", "plain", "body"],
    appendTo: (chain) => chain.setNode("paragraph"),
    id: "paragraph",
    label: "Text"
  }),
  defineCommand({
    aliases: ["h1", "title", "heading"],
    appendTo: (chain) => chain.setNode("heading", { level: 1 }),
    id: "heading-1",
    label: "Heading 1"
  }),
  defineCommand({
    aliases: ["h2", "subtitle", "heading"],
    appendTo: (chain) => chain.setNode("heading", { level: 2 }),
    id: "heading-2",
    label: "Heading 2"
  }),
  defineCommand({
    aliases: ["h3", "subheading", "heading"],
    appendTo: (chain) => chain.setNode("heading", { level: 3 }),
    id: "heading-3",
    label: "Heading 3"
  }),
  defineCommand({
    aliases: ["bullet", "unordered", "ul", "list"],
    appendTo: (chain) => chain.toggleList("bulletList", "listItem"),
    id: "bullet-list",
    label: "Bulleted list"
  }),
  defineCommand({
    aliases: ["numbered", "ordered", "ol", "list"],
    appendTo: (chain) => chain.toggleList("orderedList", "listItem"),
    id: "ordered-list",
    label: "Numbered list"
  }),
  defineCommand({
    aliases: ["quote", "blockquote", "citation"],
    appendTo: (chain) => chain.toggleWrap("blockquote"),
    id: "blockquote",
    label: "Quote"
  }),
  defineCommand({
    aliases: ["code", "pre", "snippet"],
    appendTo: (chain) => chain.toggleNode("codeBlock", "paragraph"),
    id: "code-block",
    label: "Code block"
  })
];

// Case-insensitive filter over label and aliases; an empty (or whitespace-only) query keeps the full
// catalog in its declared order. A command matches when the normalized query is a substring of its
// lower-cased label or of any alias, so `head`, `h2`, and `subtitle` all surface Heading 2.
export function filterBlockCommands(
  commands: readonly BlockCommand[],
  query: string
): readonly BlockCommand[] {
  const needle = query.trim().toLowerCase();

  if (needle === "") {
    return commands;
  }

  return commands.filter((command) => {
    if (command.label.toLowerCase().includes(needle)) {
      return true;
    }

    return command.aliases.some((alias) => alias.toLowerCase().includes(needle));
  });
}

// Runs a command as its own undoable edit (focus + transform), for surfaces that have no slash query
// to delete. The slash menu composes `appendTo` directly so the query deletion shares one undo step.
export function runBlockCommand(editor: Editor, command: BlockCommand): boolean {
  return command.appendTo(editor.chain().focus()).run();
}
