// @vitest-environment jsdom
import type { Editor, Extensions } from "@tiptap/core";
import { getSchema } from "@tiptap/core";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { documentExtensions } from "@whetstone/document";
import { afterEach, describe, expect, it } from "vitest";

import { createFormattingMenuVisibility, type FormattingMenuSelection } from "./bubbleFormatting";

const schema = getSchema(documentExtensions as unknown as Extensions);

function paragraphState(text: string): EditorState {
  const doc = schema.nodeFromJSON({
    content: [
      text === "" ? { type: "paragraph" } : { content: [{ text, type: "text" }], type: "paragraph" }
    ],
    type: "doc"
  });

  return EditorState.create({ doc, schema });
}

function withTextSelection(state: EditorState, from: number, to: number): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

function imageNodeState(): EditorState {
  const doc = schema.nodeFromJSON({
    content: [{ content: [{ attrs: { alt: "Diagram" }, type: "image" }], type: "figure" }],
    type: "doc"
  });
  const imagePos = findImagePos(doc);

  return EditorState.create({
    doc,
    schema,
    selection: NodeSelection.create(doc, imagePos)
  });
}

function findImagePos(doc: ProseMirrorNode): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (node.type.name === "image") {
      found = pos;
      return false;
    }

    return true;
  });

  if (found === -1) {
    throw new Error("Expected an image node in the fixture document.");
  }

  return found;
}

function selectionArgs(
  state: EditorState,
  overrides: {
    editable?: boolean;
    hasFocus?: boolean;
    element?: HTMLElement;
  } = {}
): FormattingMenuSelection {
  const { selection } = state;

  return {
    editor: { isEditable: overrides.editable ?? true } as unknown as Editor,
    element: overrides.element ?? document.createElement("div"),
    from: selection.from,
    state,
    to: selection.to,
    view: { hasFocus: () => overrides.hasFocus ?? true } as unknown as EditorView
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("createFormattingMenuVisibility", () => {
  it("shows the toolbar for a focused, non-empty text selection", () => {
    const { shouldShow } = createFormattingMenuVisibility();
    const state = withTextSelection(paragraphState("Hello"), 1, 6);

    expect(shouldShow(selectionArgs(state))).toBe(true);
  });

  it("hides when the editor is not editable", () => {
    const { shouldShow } = createFormattingMenuVisibility();
    const state = withTextSelection(paragraphState("Hello"), 1, 6);

    expect(shouldShow(selectionArgs(state, { editable: false }))).toBe(false);
  });

  it("hides a collapsed caret and a text selection with no characters", () => {
    const { shouldShow } = createFormattingMenuVisibility();
    const collapsed = withTextSelection(paragraphState("Hello"), 3, 3);
    const emptyBlock = withTextSelection(paragraphState(""), 1, 1);

    expect(shouldShow(selectionArgs(collapsed))).toBe(false);
    expect(shouldShow(selectionArgs(emptyBlock))).toBe(false);
  });

  it("hides a node selection that covers no text", () => {
    const { shouldShow } = createFormattingMenuVisibility();

    expect(shouldShow(selectionArgs(imageNodeState()))).toBe(false);
  });

  it("stays visible when focus moved from the document into the toolbar element", () => {
    const { shouldShow } = createFormattingMenuVisibility();
    const state = withTextSelection(paragraphState("Hello"), 1, 6);
    const element = document.createElement("div");
    const button = document.createElement("button");
    element.appendChild(button);
    document.body.appendChild(element);
    button.focus();

    expect(shouldShow(selectionArgs(state, { hasFocus: false, element }))).toBe(true);
  });

  it("hides when neither the document nor the toolbar holds focus", () => {
    const { shouldShow } = createFormattingMenuVisibility();
    const state = withTextSelection(paragraphState("Hello"), 1, 6);

    expect(shouldShow(selectionArgs(state, { hasFocus: false }))).toBe(false);
  });

  it("dismisses the current selection until the selection moves elsewhere", () => {
    const visibility = createFormattingMenuVisibility();
    const state = withTextSelection(paragraphState("Hello"), 1, 6);

    expect(visibility.shouldShow(selectionArgs(state))).toBe(true);
    visibility.dismiss(1, 6);
    expect(visibility.shouldShow(selectionArgs(state))).toBe(false);

    const moved = withTextSelection(paragraphState("Hello"), 2, 5);
    expect(visibility.shouldShow(selectionArgs(moved))).toBe(true);
    expect(visibility.shouldShow(selectionArgs(state))).toBe(true);
  });
});
