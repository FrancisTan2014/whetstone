// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { UndoRedo } from "@tiptap/extensions/undo-redo";
import { type DocumentNodeJSON, documentExtensions } from "@whetstone/document";
import type { Extensions } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  blockCommands,
  filterBlockCommands,
  runBlockCommand,
  runBlockCommandById
} from "./blockCommands";

const extensions: Extensions = [...(documentExtensions as unknown as Extensions), UndoRedo];

let editors: Editor[] = [];

function makeEditor(content: DocumentNodeJSON): Editor {
  const editor = new Editor({ content, extensions });
  editors.push(editor);
  return editor;
}

const paragraph = (text: string): DocumentNodeJSON => ({
  content: [{ content: [{ text, type: "text" }], type: "paragraph" }],
  type: "doc"
});

function topNode(editor: Editor): { type: string; level?: number } {
  const first = editor.getJSON().content?.[0];
  const level = first?.attrs?.["level"] as number | undefined;
  const type = first?.type ?? "";
  return level === undefined ? { type } : { level, type };
}

afterEach(() => {
  for (const editor of editors) {
    editor.destroy();
  }
  editors = [];
});

describe("block command catalog", () => {
  it("exposes exactly the v0 document-schema block commands in order", () => {
    expect(blockCommands.map((command) => command.id)).toEqual([
      "paragraph",
      "heading-1",
      "heading-2",
      "heading-3",
      "bullet-list",
      "ordered-list",
      "blockquote",
      "code-block"
    ]);
    expect(blockCommands.map((command) => command.label)).toEqual([
      "Text",
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Bulleted list",
      "Numbered list",
      "Quote",
      "Code block"
    ]);
  });

  it("reports every command available with a cursor in a paragraph", () => {
    const editor = makeEditor(paragraph("body"));
    editor.commands.setTextSelection(3);

    for (const command of blockCommands) {
      expect(command.isAvailable(editor)).toBe(true);
    }
  });

  it("reports no command available inside a code block", () => {
    const editor = makeEditor({
      content: [{ content: [{ text: "code", type: "text" }], type: "codeBlock" }],
      type: "doc"
    });
    editor.commands.setTextSelection(3);

    for (const command of blockCommands) {
      expect(command.isAvailable(editor)).toBe(false);
    }
  });

  it("transforms the current block into a heading, list, quote, and code block", () => {
    const cases: Array<{ id: string; type: string; level?: number }> = [
      { id: "heading-1", level: 1, type: "heading" },
      { id: "heading-2", level: 2, type: "heading" },
      { id: "heading-3", level: 3, type: "heading" },
      { id: "bullet-list", type: "bulletList" },
      { id: "ordered-list", type: "orderedList" },
      { id: "blockquote", type: "blockquote" },
      { id: "code-block", type: "codeBlock" }
    ];

    for (const testCase of cases) {
      const editor = makeEditor(paragraph("body"));
      const command = blockCommands.find((entry) => entry.id === testCase.id);

      expect(command).toBeDefined();
      expect(runBlockCommand(editor, command!)).toBe(true);
      const result = topNode(editor);
      expect(result.type).toBe(testCase.type);

      if (testCase.level !== undefined) {
        expect(result.level).toBe(testCase.level);
      }
    }
  });

  it("keeps a paragraph a paragraph when applying the Text command", () => {
    const editor = makeEditor({
      content: [{ attrs: { level: 2 }, content: [{ text: "H", type: "text" }], type: "heading" }],
      type: "doc"
    });
    const text = blockCommands.find((command) => command.id === "paragraph");

    expect(runBlockCommand(editor, text!)).toBe(true);
    expect(topNode(editor).type).toBe("paragraph");
  });

  it("preserves the addressable top-level block id across every v0 transform", () => {
    const collectIds = (node: DocumentNodeJSON): string[] => {
      const id = node.attrs?.["id"];
      const own = typeof id === "string" ? [id] : [];
      const children = (node.content ?? []).flatMap((child) => collectIds(child));
      return [...own, ...children];
    };
    const seeded = (id: string): DocumentNodeJSON => ({
      content: [{ attrs: { id }, content: [{ text: "body", type: "text" }], type: "paragraph" }],
      type: "doc"
    });

    for (const command of blockCommands) {
      const editor = makeEditor(seeded("p-original"));
      editor.commands.setTextSelection(3);

      expect(runBlockCommand(editor, command)).toBe(true);

      const doc = editor.getJSON() as DocumentNodeJSON;
      const topLevel = doc.content?.[0];
      // The resulting addressable top-level block keeps the original block's stable id, whether the
      // command replaces the node in place (Text, headings, Code block) or wraps it (lists, Quote).
      expect(topLevel?.attrs?.["id"]).toBe("p-original");

      // A wrapping command must not leave the same id on a nested node too: ids stay unique so the
      // note-anchor and autosaved stable-id paths address exactly one block.
      const ids = collectIds(doc);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("runs a catalog command by id and reports an unknown id as not run", () => {
    const editor = makeEditor(paragraph("body"));

    expect(runBlockCommandById(editor, "blockquote")).toBe(true);
    expect(topNode(editor).type).toBe("blockquote");
    expect(runBlockCommandById(editor, "does-not-exist")).toBe(false);
  });
});

describe("filterBlockCommands", () => {
  it("returns the full catalog for an empty or whitespace query", () => {
    expect(filterBlockCommands(blockCommands, "")).toHaveLength(blockCommands.length);
    expect(filterBlockCommands(blockCommands, "   ")).toHaveLength(blockCommands.length);
  });

  it("matches on the label case-insensitively", () => {
    expect(filterBlockCommands(blockCommands, "HEAD").map((command) => command.id)).toEqual([
      "heading-1",
      "heading-2",
      "heading-3"
    ]);
  });

  it("matches on an alias not shown in the label", () => {
    expect(filterBlockCommands(blockCommands, "h2").map((command) => command.id)).toEqual([
      "heading-2"
    ]);
    expect(filterBlockCommands(blockCommands, "list").map((command) => command.id)).toEqual([
      "bullet-list",
      "ordered-list"
    ]);
  });

  it("returns nothing when neither label nor alias matches", () => {
    expect(filterBlockCommands(blockCommands, "zzz")).toEqual([]);
  });
});
