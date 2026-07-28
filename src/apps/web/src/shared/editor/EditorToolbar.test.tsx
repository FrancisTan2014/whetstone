// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  // Radix reads pointer capture APIs jsdom lacks; stub them so menu interactions do not throw.
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: () => {}
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
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

function heading(level: number, text: string): DocumentNodeJSON {
  return {
    content: [{ attrs: { level }, content: [{ text, type: "text" }], type: "heading" }],
    type: "doc"
  };
}

const blockquoteDocument: DocumentNodeJSON = {
  content: [
    {
      content: [{ content: [{ text: "Cited", type: "text" }], type: "paragraph" }],
      type: "blockquote"
    }
  ],
  type: "doc"
};

const codeBlockDocument: DocumentNodeJSON = {
  content: [{ content: [{ text: "const x = 1;", type: "text" }], type: "codeBlock" }],
  type: "doc"
};

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

function toolbarItems(toolbar: HTMLElement): HTMLElement[] {
  return Array.from(toolbar.querySelectorAll<HTMLElement>("[data-toolbar-item]"));
}

async function openStyleMenu(
  toolbar: HTMLElement,
  user: ReturnType<typeof userEvent.setup>
): Promise<HTMLElement> {
  await user.click(within(toolbar).getByRole("button", { name: "Block style" }));
  return screen.findByRole("menu", { name: "Block style" });
}

describe("EditorToolbar", () => {
  it("renders one style menu trigger plus the inline, list, and history controls", async () => {
    const { toolbar } = await mount(paragraph("Passage"));

    expect(within(toolbar).getByRole("button", { name: "Block style" })).toBeDefined();
    for (const name of [
      "Bold",
      "Italic",
      "Inline code",
      "Bulleted list",
      "Numbered list",
      "Undo",
      "Redo"
    ]) {
      expect(within(toolbar).getByRole("button", { name })).toBeDefined();
    }
  });

  it("names the current block type on the style trigger", async () => {
    for (const [doc, label] of [
      [paragraph("Body"), "Text"],
      [heading(1, "Title"), "Heading 1"],
      [heading(2, "Sub"), "Heading 2"],
      [heading(3, "Minor"), "Heading 3"],
      [blockquoteDocument, "Quote"],
      [codeBlockDocument, "Code block"]
    ] as const) {
      const { toolbar } = await mount(doc);
      expect(within(toolbar).getByRole("button", { name: "Block style" }).textContent).toContain(
        label
      );
      cleanup();
    }
  });

  it("opens the style menu with every block-style option", async () => {
    const { toolbar, user } = await mount(paragraph("Passage"));
    const menu = await openStyleMenu(toolbar, user);

    for (const name of ["Text", "Heading 1", "Heading 2", "Heading 3", "Quote", "Code block"]) {
      expect(within(menu).getByRole("menuitem", { name })).toBeDefined();
    }
  });

  it("marks the active block type in the open style menu", async () => {
    const { toolbar, user } = await mount(heading(1, "Title"));
    const menu = await openStyleMenu(toolbar, user);

    expect(
      within(menu).getByRole("menuitem", { name: "Heading 1" }).getAttribute("aria-current")
    ).toBe("true");
    expect(
      within(menu).getByRole("menuitem", { name: "Text" }).getAttribute("aria-current")
    ).toBeNull();
  });

  it("turns the current block into a heading through the style menu", async () => {
    const { editor, toolbar, user } = await mount(paragraph("Passage"));
    const menu = await openStyleMenu(toolbar, user);

    await user.click(within(menu).getByRole("menuitem", { name: "Heading 2" }));

    expect(topTypes(editor)).toEqual(["heading"]);
    expect(editor.getJSON().content?.[0]?.attrs?.["level"]).toBe(2);
    await waitFor(() =>
      expect(within(toolbar).getByRole("button", { name: "Block style" }).textContent).toContain(
        "Heading 2"
      )
    );
  });

  it("turns a code block back into text through the style menu", async () => {
    const { editor, toolbar, user } = await mount(codeBlockDocument);
    const menu = await openStyleMenu(toolbar, user);

    await user.click(within(menu).getByRole("menuitem", { name: "Text" }));

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

  it("toggles the bold mark on the selection and reflects it", async () => {
    const { editor, toolbar, user } = await mount(paragraph("Passage"));
    editor.commands.selectAll();

    const bold = within(toolbar).getByRole("button", { name: "Bold" });
    expect(bold.getAttribute("aria-pressed")).toBe("false");

    await user.click(bold);

    expect(editor.isActive("bold")).toBe(true);
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

  it("keeps the editor focused by claiming the mousedown on every formatting and history control", async () => {
    const { toolbar } = await mount(paragraph("Passage"));

    // A toolbar press must not blur the editor: each formatting/history control claims its mousedown so the
    // caret and selection stay in the document (and the first press right after the block-style menu closes
    // is not swallowed). The Block style trigger is excluded — Radix owns its pointer behavior to open.
    for (const name of [
      "Bold",
      "Italic",
      "Inline code",
      "Bulleted list",
      "Numbered list",
      "Undo",
      "Redo"
    ]) {
      const control = within(toolbar).getByRole("button", { name });
      const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      control.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
    }
  });

  it("keeps the history controls focusable via aria-disabled when nothing can undo or redo", async () => {
    const { toolbar } = await mount(paragraph("Passage"));

    for (const name of ["Undo", "Redo"]) {
      const control = within(toolbar).getByRole("button", { name }) as HTMLButtonElement;
      expect(control.getAttribute("aria-disabled")).toBe("true");
      // Not the native attribute, so it stays in the roving tab-arrow order.
      expect(control.disabled).toBe(false);
    }
  });

  it("does not run undo while nothing can be undone", async () => {
    const { editor, toolbar, user } = await mount(paragraph("Passage"));

    await user.click(within(toolbar).getByRole("button", { name: "Undo" }));

    expect(editorText(editor)).toBe("Passage");
  });

  it("does not run redo while nothing can be redone", async () => {
    const { editor, toolbar, user } = await mount(paragraph("Passage"));

    await user.click(within(toolbar).getByRole("button", { name: "Redo" }));

    expect(editorText(editor)).toBe("Passage");
  });

  it("reverts the last edit when undo is available", async () => {
    const { editor, toolbar, user } = mountToolbar((instance) => {
      instance.chain().focus("end").insertContent(" edited").run();
    });
    expect(editorText(editor)).toBe("Passage edited");

    const undo = within(toolbar).getByRole("button", { name: "Undo" });
    expect(undo.getAttribute("aria-disabled")).toBe("false");
    await user.click(undo);

    expect(editorText(editor)).toBe("Passage");
  });

  it("re-applies an undone edit when redo is available", async () => {
    const { editor, toolbar, user } = mountToolbar((instance) => {
      instance.chain().focus("end").insertContent(" edited").run();
      instance.commands.undo();
    });
    expect(editorText(editor)).toBe("Passage");

    const redo = within(toolbar).getByRole("button", { name: "Redo" });
    expect(redo.getAttribute("aria-disabled")).toBe("false");
    await user.click(redo);

    expect(editorText(editor)).toBe("Passage edited");
  });

  it("is a single tab stop with a roving tabindex", async () => {
    const { toolbar } = await mount(paragraph("Passage"));
    const items = toolbarItems(toolbar);

    expect(items).toHaveLength(8);
    expect(items[0]!.getAttribute("tabindex")).toBe("0");
    for (const item of items.slice(1)) {
      expect(item.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("moves focus with the arrow, Home, and End keys, wrapping at the ends", async () => {
    const { toolbar } = await mount(paragraph("Passage"));
    const items = toolbarItems(toolbar);
    const last = items.length - 1;

    act(() => items[0]!.focus());

    fireEvent.keyDown(items[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(items[1]);
    await waitFor(() => expect(items[1]!.getAttribute("tabindex")).toBe("0"));
    expect(items[0]!.getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(items[1]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(items[0]!, { key: "End" });
    expect(document.activeElement).toBe(items[last]);

    fireEvent.keyDown(items[last]!, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);

    // Wrap: ArrowLeft from the first control lands on the last, ArrowRight from the last on the first.
    fireEvent.keyDown(items[0]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(items[last]);

    fireEvent.keyDown(items[last]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(items[0]);
  });

  it("ignores non-navigation keys and keys pressed while focus is outside the toolbar", async () => {
    const { toolbar } = await mount(paragraph("Passage"));
    const items = toolbarItems(toolbar);

    act(() => items[0]!.focus());
    fireEvent.keyDown(items[0]!, { key: "a" });
    expect(document.activeElement).toBe(items[0]);

    // Focus a real control outside the toolbar: the handler finds no current item and no-ops (the open
    // menu portals its content outside the toolbar, so arrow keys there are Radix's, not the roving list's).
    const outside = window.document.createElement("button");
    window.document.body.append(outside);
    act(() => outside.focus());
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    expect(toolbarItems(toolbar)[0]!.getAttribute("tabindex")).toBe("0");
    outside.remove();
  });
});
