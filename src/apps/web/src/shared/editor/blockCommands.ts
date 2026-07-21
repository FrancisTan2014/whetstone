import type { ChainedCommands, Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

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

// The addressable top-level block containing the selection (depth 1): its position, node, and stable
// id. Positions and ids are read from the running transaction so this is correct both before and
// after a transform composed earlier in the same chain. These commands only run on a textblock
// selection (see `isBlockTransformContext`), so the selection always sits at depth >= 1 and the
// depth-1 ancestor is the top-level block — for a nested selection (e.g. inside a list) that ancestor
// is the wrapping list, exactly the addressable block we must keep stable.
function topLevelBlock(tr: Transaction): { pos: number; node: ProseMirrorNode; id: string | null } {
  const selectionFrom = tr.selection.$from;
  // A whole-document selection (Ctrl/Cmd+A → AllSelection) resolves `$from` at the document boundary
  // (depth 0), where there is no depth-1 block and `$from.node(1)` is undefined. Step one position
  // inside so the FIRST top-level block is the addressable block — the persistent toolbar can run a
  // block command under such a selection, where the slash menu (always a caret) never does.
  const $from =
    selectionFrom.depth === 0
      ? tr.doc.resolve(Math.min(selectionFrom.pos + 1, tr.doc.content.size))
      : selectionFrom;
  const node = $from.node(1);
  const id = node.attrs["id"];
  return { id: typeof id === "string" ? id : null, node, pos: $from.before(1) };
}

// Keep a block's stable id on the addressable top-level block across any transform (#588). A wrapping
// command (Bulleted list, Numbered list, Quote) builds a NEW top-level node around the block, so the
// original id would otherwise stay only on the now-nested paragraph and the addressable top-level id
// would change — breaking note anchors and the autosaved stable-id path. Capture the top-level id
// before the transform; afterwards stamp it back onto the resulting top-level node and clear it from
// any nested node that still carries it, so UniqueID reassigns that nested node a fresh id and the
// preserved id addresses exactly one block. For non-wrapping commands (Text, headings, Code block)
// the top-level node is unchanged, so the restamp is a no-op and no nested node holds the id.
function withPreservedBlockId(
  applyTransform: (chain: ChainedCommands) => ChainedCommands
): (chain: ChainedCommands) => ChainedCommands {
  return (chain) => {
    const preserved: { id: string | null } = { id: null };

    return applyTransform(
      chain.command(({ tr }) => {
        preserved.id = topLevelBlock(tr).id;
        return true;
      })
    ).command(({ dispatch, tr }) => {
      const preservedId = preserved.id;

      if (dispatch && preservedId !== null) {
        const target = topLevelBlock(tr);
        tr.setNodeAttribute(target.pos, "id", preservedId);
        target.node.descendants((node, offset) => {
          if (node.attrs["id"] === preservedId) {
            tr.setNodeAttribute(target.pos + 1 + offset, "id", null);
          }
          return undefined;
        });
      }

      return true;
    });
  };
}

function defineCommand(definition: BlockCommandDefinition): BlockCommand {
  return {
    ...definition,
    appendTo: withPreservedBlockId(definition.appendTo),
    isAvailable: isBlockTransformContext
  };
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

// Runs the catalog command with the given id, or returns false when no command matches. This is the
// by-identity seam every non-slash editor surface uses — the full toolbar's Block style select and
// its Bulleted list / Numbered list / Quote / Code block buttons — so stable-id preservation applies
// uniformly no matter which surface triggers the transform (#588), rather than each surface issuing
// its own raw Tiptap chain.
export function runBlockCommandById(editor: Editor, id: string): boolean {
  const command = blockCommands.find((candidate) => candidate.id === id);

  if (command === undefined) {
    return false;
  }

  return runBlockCommand(editor, command);
}
