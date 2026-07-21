// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Editor, type Extensions } from "@tiptap/core";
import { UndoRedo } from "@tiptap/extensions/undo-redo";
import { EditorContent, useEditor } from "@tiptap/react";
import { type DocumentNodeJSON, documentExtensions, documentText } from "@whetstone/document";
import { useEffect, useRef } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { EditorToolbar } from "./EditorToolbar";

beforeAll(() => {
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect()
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [] as unknown as DOMRectList
  });
  Object.defineProperty(HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value: () => [] as unknown as DOMRectList
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect()
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {}
  });
});

afterEach(() => {
  cleanup();
});

const extensions = [...(documentExtensions as unknown as Extensions), UndoRedo];

function paragraph(text: string): DocumentNodeJSON {
  return {
    content: [{ content: [{ text, type: "text" }], type: "paragraph" }],
    type: "doc"
  };
}

function topTypes(editor: Editor): string[] {
  return (editor.getJSON().content ?? []).map((node) => node.type ?? "");
}

// Tiptap's `getJSON()` returns its own loose JSONContent shape; the editor only ever holds valid
// document nodes here, so read its plaintext through the shared `documentText` with a narrow cast.
function editorText(editor: Editor): string {
  return documentText(editor.getJSON() as DocumentNodeJSON);
}

function Harness({
  document: doc,
  onReady
}: Readonly<{
  document: DocumentNodeJSON;
  onReady: (editor: Editor) => void;
}>): React.JSX.Element | null {
  const readyRef = useRef(false);
  const editor = useEditor({
    content: doc,
    editorProps: {
      attributes: { "aria-label": "Rich content editor", "aria-multiline": "true", role: "textbox" }
    },
    extensions,
    immediatelyRender: false,
    shouldRerenderOnTransaction: true
  });

  useEffect(() => {
    if (editor === null || readyRef.current) {
      return;
    }
    readyRef.current = true;
    onReady(editor);
  }, [editor, onReady]);

  if (editor === null) {
    return null;
  }

  return (
    <>
      <EditorToolbar editor={editor} />
      <EditorContent editor={editor} />
    </>
  );
}

async function mount(
  doc: DocumentNodeJSON
): Promise<{ editor: Editor; toolbar: HTMLElement; user: ReturnType<typeof userEvent.setup> }> {
  let editor: Editor | undefined;
  const user = userEvent.setup();
  render(<Harness document={doc} onReady={(instance) => (editor = instance)} />);
  await waitFor(() => expect(editor).toBeDefined());
  const toolbar = screen.getByRole("toolbar", { name: "Formatting" });
  return { editor: editor as Editor, toolbar, user };
}

// Render only the toolbar over a directly-built editor whose history is seeded before first paint, so
// the undo/redo enabled state is present at initial render. This sidesteps the jsdom
// shouldRerenderOnTransaction re-render race the rest of the codebase also avoids for post-edit reflection.
function mountToolbar(seed: (editor: Editor) => void): {
  editor: Editor;
  toolbar: HTMLElement;
  user: ReturnType<typeof userEvent.setup>;
} {
  const editor = new Editor({ content: paragraph("Passage"), extensions });
  seed(editor);
  const user = userEvent.setup();
  render(<EditorToolbar editor={editor} />);
  const toolbar = screen.getByRole("toolbar", { name: "Formatting" });
  return { editor, toolbar, user };
}

describe("EditorToolbar", () => {
  it("renders every block, list, mark, and history control", async () => {
    const { toolbar } = await mount(paragraph("Passage"));

    for (const name of [
      "Paragraph",
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Bulleted list",
      "Numbered list",
      "Quote",
      "Code block",
      "Bold",
      "Italic",
      "Inline code",
      "Undo",
      "Redo"
    ]) {
      expect(within(toolbar).getByRole("button", { name })).toBeDefined();
    }
  });

  it("turns the current block into a heading and reflects the active level", async () => {
    const { editor, toolbar, user } = await mount(paragraph("Passage"));

    const heading = within(toolbar).getByRole("button", { name: "Heading 2" });
    expect(heading.getAttribute("aria-pressed")).toBe("false");

    await user.click(heading);

    expect(topTypes(editor)).toEqual(["heading"]);
    expect(editor.getJSON().content?.[0]?.attrs?.["level"]).toBe(2);
    expect(editor.isActive("heading", { level: 2 })).toBe(true);
  });

  it("shows a block control as pressed when the selection already sits in that block type", async () => {
    const headingDocument: DocumentNodeJSON = {
      content: [
        { attrs: { level: 1 }, content: [{ text: "Title", type: "text" }], type: "heading" }
      ],
      type: "doc"
    };
    const { toolbar } = await mount(headingDocument);

    expect(
      within(toolbar).getByRole("button", { name: "Heading 1" }).getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      within(toolbar).getByRole("button", { name: "Paragraph" }).getAttribute("aria-pressed")
    ).toBe("false");
  });

  it("turns the current block into a code block and back to a paragraph", async () => {
    const { editor, toolbar, user } = await mount(paragraph("Passage"));

    await user.click(within(toolbar).getByRole("button", { name: "Code block" }));
    expect(topTypes(editor)).toEqual(["codeBlock"]);

    await user.click(within(toolbar).getByRole("button", { name: "Paragraph" }));
    expect(topTypes(editor)).toEqual(["paragraph"]);
  });

  it("wraps the current block in a bulleted list", async () => {
    const { editor, toolbar, user } = await mount(paragraph("Item"));

    await user.click(within(toolbar).getByRole("button", { name: "Bulleted list" }));

    expect(topTypes(editor)).toEqual(["bulletList"]);
  });

  it("wraps the current block in a numbered list", async () => {
    const { editor, toolbar, user } = await mount(paragraph("Item"));

    await user.click(within(toolbar).getByRole("button", { name: "Numbered list" }));

    expect(topTypes(editor)).toEqual(["orderedList"]);
  });

  it("wraps the current block in a quote", async () => {
    const { editor, toolbar, user } = await mount(paragraph("Cited"));

    await user.click(within(toolbar).getByRole("button", { name: "Quote" }));

    expect(topTypes(editor)).toEqual(["blockquote"]);
  });

  it("toggles the bold mark on the selection", async () => {
    const { editor, toolbar, user } = await mount(paragraph("Passage"));
    editor.commands.selectAll();

    const bold = within(toolbar).getByRole("button", { name: "Bold" });
    expect(bold.getAttribute("aria-pressed")).toBe("false");

    await user.click(bold);

    expect(editor.isActive("bold")).toBe(true);
  });

  it("shows a mark control as pressed when the selection already carries that mark", async () => {
    const boldDocument: DocumentNodeJSON = {
      content: [
        {
          content: [{ marks: [{ type: "bold" }], text: "Strong", type: "text" }],
          type: "paragraph"
        }
      ],
      type: "doc"
    };
    const { editor, toolbar } = await mount(boldDocument);
    editor.commands.selectAll();

    await waitFor(() =>
      expect(
        within(toolbar).getByRole("button", { name: "Bold" }).getAttribute("aria-pressed")
      ).toBe("true")
    );
  });

  it("toggles the italic mark on the selection", async () => {
    const { editor, toolbar, user } = await mount(paragraph("Passage"));
    editor.commands.selectAll();

    await user.click(within(toolbar).getByRole("button", { name: "Italic" }));

    expect(editor.isActive("italic")).toBe(true);
  });

  it("toggles inline code on the selection", async () => {
    const { editor, toolbar, user } = await mount(paragraph("Passage"));
    editor.commands.selectAll();

    await user.click(within(toolbar).getByRole("button", { name: "Inline code" }));

    expect(editor.isActive("code")).toBe(true);
  });

  it("disables both history controls when there is nothing to undo or redo", async () => {
    const { toolbar } = await mount(paragraph("Passage"));

    expect(
      (within(toolbar).getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (within(toolbar).getByRole("button", { name: "Redo" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("reverts the last edit when undo is available", async () => {
    const { editor, toolbar, user } = mountToolbar((instance) => {
      instance.chain().focus("end").insertContent(" edited").run();
    });
    expect(editorText(editor)).toBe("Passage edited");

    const undo = within(toolbar).getByRole("button", { name: "Undo" }) as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    await user.click(undo);

    expect(editorText(editor)).toBe("Passage");
  });

  it("re-applies an undone edit when redo is available", async () => {
    const { editor, toolbar, user } = mountToolbar((instance) => {
      instance.chain().focus("end").insertContent(" edited").run();
      instance.commands.undo();
    });
    expect(editorText(editor)).toBe("Passage");

    const redo = within(toolbar).getByRole("button", { name: "Redo" }) as HTMLButtonElement;
    expect(redo.disabled).toBe(false);
    await user.click(redo);

    expect(editorText(editor)).toBe("Passage edited");
  });
});
