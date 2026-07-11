import { documentSchema } from "@whetstone/document";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { EditorState } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

import { isSlashContextAllowed } from "./slashCommandContext";

const schema = documentSchema;

function stateWithCursor(doc: ProseMirrorNode, pos: number): EditorState {
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
}

const link = () => schema.marks["link"]!.create({ href: "https://example.com" });
const code = () => schema.marks["code"]!.create();

describe("isSlashContextAllowed", () => {
  it("allows a slash in a plain paragraph", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("hello")])]);

    expect(isSlashContextAllowed(stateWithCursor(doc, 3))).toBe(true);
  });

  it("allows a slash in a heading", () => {
    const doc = schema.node("doc", null, [
      schema.node("heading", { level: 2 }, [schema.text("title")])
    ]);

    expect(isSlashContextAllowed(stateWithCursor(doc, 3))).toBe(true);
  });

  it("blocks a slash inside a code block", () => {
    const doc = schema.node("doc", null, [
      schema.node("codeBlock", null, [schema.text("const x = 1")])
    ]);

    expect(isSlashContextAllowed(stateWithCursor(doc, 3))).toBe(false);
  });

  it("blocks a slash inside an inline-code run", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("run", [code()])])
    ]);

    expect(isSlashContextAllowed(stateWithCursor(doc, 2))).toBe(false);
  });

  it("blocks a slash inside a link", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("home", [link()])])
    ]);

    expect(isSlashContextAllowed(stateWithCursor(doc, 2))).toBe(false);
  });

  it("blocks a slash when a link mark is toggled on via stored marks", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("plain")])]);
    const base = stateWithCursor(doc, 3);
    const withStoredLink = base.apply(base.tr.setStoredMarks([link()]));

    expect(isSlashContextAllowed(withStoredLink)).toBe(false);
  });

  it("blocks a slash when the selection is not inside a textblock", () => {
    const doc = schema.node("doc", null, [schema.node("unknown", { html: "<x>raw</x>" })]);
    const state = EditorState.create({ doc, selection: NodeSelection.create(doc, 0) });

    expect(isSlashContextAllowed(state)).toBe(false);
  });
});
