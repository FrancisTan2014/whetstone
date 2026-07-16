// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor, Extensions } from "@tiptap/core";
import { UndoRedo } from "@tiptap/extensions/undo-redo";
import { EditorContent, useEditor } from "@tiptap/react";
import { type DocumentNodeJSON, documentExtensions } from "@whetstone/document";
import { useEffect, useRef, useState } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { BlockActionsMenu } from "./BlockActionsMenu";
import { Button } from "../ui/Button.js";

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

function paragraphs(...items: Array<{ id: string; text: string }>): DocumentNodeJSON {
  return {
    content: items.map((item) => ({
      attrs: { id: item.id },
      content: [{ text: item.text, type: "text" }],
      type: "paragraph"
    })),
    type: "doc"
  };
}

const codeBlockDocument: DocumentNodeJSON = {
  content: [{ content: [{ text: "const x = 1;", type: "text" }], type: "codeBlock" }],
  type: "doc"
};

function blockStart(editor: Editor, index: number): number {
  let pos = 0;
  editor.state.doc.forEach((_node, offset, i) => {
    if (i === index) {
      pos = offset;
    }
  });
  return pos;
}

function topTypes(editor: Editor): string[] {
  return (editor.getJSON().content ?? []).map((node) => node.type ?? "");
}

function topTexts(editor: Editor): string[] {
  return (editor.getJSON().content ?? []).map(
    (node) =>
      (node.content ?? []).map((child) => (child as { text?: string }).text ?? "").join("") ?? ""
  );
}

function topIds(editor: Editor): Array<string | undefined> {
  return (editor.getJSON().content ?? []).map((node) => node.attrs?.["id"] as string | undefined);
}

function Harness({
  document: doc,
  blockIndex,
  container,
  onReady
}: {
  document: DocumentNodeJSON;
  blockIndex: number;
  container?: () => HTMLElement;
  onReady?: (editor: Editor) => void;
}): React.JSX.Element | null {
  const readyRef = useRef(false);
  const [open, setOpen] = useState(false);
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
    onReady?.(editor);
  }, [editor, onReady]);

  if (editor === null) {
    return null;
  }

  return (
    <>
      <BlockActionsMenu
        editor={editor}
        onOpenChange={setOpen}
        open={open}
        pos={blockStart(editor, blockIndex)}
        trigger={<Button aria-label="Block actions">Grip</Button>}
        {...(container === undefined ? {} : { container })}
      />
      <EditorContent editor={editor} />
    </>
  );
}

async function openMenu(
  doc: DocumentNodeJSON,
  blockIndex = 0
): Promise<{ editor: Editor; menu: HTMLElement; user: ReturnType<typeof userEvent.setup> }> {
  let editor: Editor | undefined;
  const user = userEvent.setup();
  render(<Harness blockIndex={blockIndex} document={doc} onReady={(e) => (editor = e)} />);
  await waitFor(() => expect(editor).toBeDefined());
  await user.click(screen.getByRole("button", { name: "Block actions" }));
  const menu = await screen.findByRole("menu", { name: "Block actions" });
  return { editor: editor as Editor, menu, user };
}

describe("BlockActionsMenu structure", () => {
  it("opens a menu exposing every block action", async () => {
    const { menu } = await openMenu(paragraphs({ id: "a", text: "One" }, { id: "b", text: "Two" }));

    for (const label of [
      "Turn into",
      "Insert above",
      "Insert below",
      "Duplicate",
      "Move up",
      "Move down",
      "Delete"
    ]) {
      expect(within(menu).getByRole("menuitem", { name: new RegExp(label) })).toBeTruthy();
    }
  });

  it("disables Move up on the first block", async () => {
    const { menu } = await openMenu(
      paragraphs({ id: "a", text: "One" }, { id: "b", text: "Two" }),
      0
    );

    expect(
      within(menu).getByRole("menuitem", { name: "Move up" }).getAttribute("aria-disabled")
    ).toBe("true");
    expect(
      within(menu).getByRole("menuitem", { name: "Move down" }).getAttribute("aria-disabled")
    ).not.toBe("true");
  });

  it("disables Move down on the last block", async () => {
    const { menu } = await openMenu(
      paragraphs({ id: "a", text: "One" }, { id: "b", text: "Two" }),
      1
    );

    expect(
      within(menu).getByRole("menuitem", { name: "Move down" }).getAttribute("aria-disabled")
    ).toBe("true");
    expect(
      within(menu).getByRole("menuitem", { name: "Move up" }).getAttribute("aria-disabled")
    ).not.toBe("true");
  });

  it("presents Turn into as a disabled item with an explanation on a code block", async () => {
    const { menu } = await openMenu(codeBlockDocument);

    const turnInto = within(menu).getByRole("menuitem", { name: /Turn into/ });
    expect(turnInto.getAttribute("aria-disabled")).toBe("true");
    expect(turnInto.textContent).toContain("code block");
  });
});

describe("BlockActionsMenu actions", () => {
  it("turns the block into another type through the shared catalog, preserving its id", async () => {
    const { editor, user } = await openMenu(
      paragraphs({ id: "a", text: "One" }, { id: "b", text: "Two" })
    );
    // Drive the submenu from the keyboard: Radix submenus open on hover coordinates that jsdom lacks,
    // but keyboard navigation (Enter opens the submenu, arrows move within it) is deterministic.
    await user.keyboard("{ArrowDown}"); // focus "Turn into"
    await user.keyboard("{Enter}"); // open the submenu, focus its first item ("Text")
    await user.keyboard("{ArrowDown}"); // move to "Heading 1"
    await user.keyboard("{Enter}"); // select it

    await waitFor(() => expect(topTypes(editor)[0]).toBe("heading"));
    expect(topIds(editor)[0]).toBe("a");
  });

  it("inserts an empty paragraph above the block", async () => {
    const { editor, menu, user } = await openMenu(paragraphs({ id: "a", text: "One" }));

    await user.click(within(menu).getByRole("menuitem", { name: "Insert above" }));

    await waitFor(() => expect(editor.state.doc.childCount).toBe(2));
    expect(topTexts(editor)).toEqual(["", "One"]);
  });

  it("inserts an empty paragraph below the block", async () => {
    const { editor, menu, user } = await openMenu(paragraphs({ id: "a", text: "One" }));

    await user.click(within(menu).getByRole("menuitem", { name: "Insert below" }));

    await waitFor(() => expect(editor.state.doc.childCount).toBe(2));
    expect(topTexts(editor)).toEqual(["One", ""]);
  });

  it("duplicates the block below it with a fresh id", async () => {
    const { editor, menu, user } = await openMenu(paragraphs({ id: "a", text: "One" }));

    await user.click(within(menu).getByRole("menuitem", { name: "Duplicate" }));

    await waitFor(() => expect(editor.state.doc.childCount).toBe(2));
    expect(topTexts(editor)).toEqual(["One", "One"]);
    const [first, second] = topIds(editor);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("moves the block up, preserving ids", async () => {
    const { editor, menu, user } = await openMenu(
      paragraphs({ id: "a", text: "One" }, { id: "b", text: "Two" }),
      1
    );

    await user.click(within(menu).getByRole("menuitem", { name: "Move up" }));

    await waitFor(() => expect(topTexts(editor)).toEqual(["Two", "One"]));
    expect(topIds(editor)).toEqual(["b", "a"]);
  });

  it("moves the block down, preserving ids", async () => {
    const { editor, menu, user } = await openMenu(
      paragraphs({ id: "a", text: "One" }, { id: "b", text: "Two" }),
      0
    );

    await user.click(within(menu).getByRole("menuitem", { name: "Move down" }));

    await waitFor(() => expect(topTexts(editor)).toEqual(["Two", "One"]));
    expect(topIds(editor)).toEqual(["b", "a"]);
  });

  it("deletes the block", async () => {
    const { editor, menu, user } = await openMenu(
      paragraphs({ id: "a", text: "One" }, { id: "b", text: "Two" }),
      0
    );

    await user.click(within(menu).getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(topTexts(editor)).toEqual(["Two"]));
  });

  it("leaves one empty paragraph when the final block is deleted", async () => {
    const { editor, menu, user } = await openMenu(paragraphs({ id: "a", text: "Only" }));

    await user.click(within(menu).getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(editor.state.doc.childCount).toBe(1));
    expect(topTypes(editor)).toEqual(["paragraph"]);
    expect(topTexts(editor)).toEqual([""]);
  });
});

describe("BlockActionsMenu focus", () => {
  it("returns focus to the editor after an action", async () => {
    const { editor, menu, user } = await openMenu(paragraphs({ id: "a", text: "One" }));

    await user.click(within(menu).getByRole("menuitem", { name: "Duplicate" }));

    await waitFor(() => expect(editor.view.hasFocus()).toBe(true));
  });

  it("returns focus to the editor when dismissed with Escape", async () => {
    const { editor, user } = await openMenu(paragraphs({ id: "a", text: "One" }));

    await user.keyboard("{Escape}");

    await waitFor(() => expect(editor.view.hasFocus()).toBe(true));
  });
});

describe("BlockActionsMenu inside a Sheet's floating layer", () => {
  it("portals into the provided container and ignores focus-outside so a dialog's focus trap cannot dismiss it", async () => {
    const host = window.document.createElement("div");
    window.document.body.appendChild(host);
    const outside = window.document.createElement("button");
    window.document.body.appendChild(outside);
    let editor: Editor | undefined;
    const user = userEvent.setup();
    render(
      <Harness
        blockIndex={0}
        container={() => host}
        document={paragraphs({ id: "a", text: "One" })}
        onReady={(e) => (editor = e)}
      />
    );
    await waitFor(() => expect(editor).toBeDefined());

    await user.click(screen.getByRole("button", { name: "Block actions" }));
    const menu = await screen.findByRole("menu", { name: "Block actions" });
    // The menu portals into the provided host node (inside the Dialog), not document.body.
    expect(host.contains(menu)).toBe(true);

    // A modal Sheet's focus trap nudges focus outside the non-modal menu as it opens; the portaled
    // guard must ignore that focus-outside so the menu survives instead of self-dismissing.
    await act(async () => {
      outside.focus();
    });
    expect(screen.queryByRole("menu", { name: "Block actions" })).not.toBeNull();

    host.remove();
    outside.remove();
  });
});
