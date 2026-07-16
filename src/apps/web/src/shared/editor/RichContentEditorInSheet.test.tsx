// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DocumentNodeJSON } from "@whetstone/document";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RichContentEditor } from "./RichContentEditor.js";
import { Sheet } from "../ui/Sheet.js";

// The shared editor's four floating surfaces (formatting toolbar, link form, slash menu, block-actions
// menu) must stay visible and interactive when the editor is hosted in a modal Sheet: they have to
// portal into the Sheet's above-overlay floating host, which lives INSIDE the Radix Dialog (not
// aria-hidden, inside the focus scope), instead of body-level portals the modal renders inert (#645).
// The editor is a real Tiptap instance here (as in RichContentEditor.test.tsx); jsdom lacks the layout
// primitives its suggestion decoration and floating-ui positioning read, so stub the few used.
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
  for (const method of [
    "hasPointerCapture",
    "setPointerCapture",
    "releasePointerCapture"
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, method, {
      configurable: true,
      value: () => (method === "hasPointerCapture" ? false : undefined)
    });
  }
});

function mockMatchMedia(matches = false): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches,
    media: query,
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn()
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  mockMatchMedia(false);
});

afterEach(() => {
  cleanup();
});

const paragraph = (text: string): DocumentNodeJSON => ({
  content: [
    text === "" ? { type: "paragraph" } : { content: [{ text, type: "text" }], type: "paragraph" }
  ],
  type: "doc"
});

const codeBlockDoc: DocumentNodeJSON = {
  content: [{ content: [{ text: "let x = 1", type: "text" }], type: "codeBlock" }],
  type: "doc"
};

async function mountEditorInSheet(document: DocumentNodeJSON = paragraph("")) {
  const onChange = vi.fn<(next: DocumentNodeJSON) => void>();
  const user = userEvent.setup();
  render(
    <Sheet onOpenChange={vi.fn()} open title="Edit note">
      <RichContentEditor
        ariaLabel="Note body"
        document={document}
        onChange={onChange}
        presentation="compact"
      />
    </Sheet>
  );
  const dialog = await screen.findByRole("dialog", { name: "Edit note" });
  const textbox = await within(dialog).findByRole("textbox", { name: "Note body" });
  const host = dialog.querySelector(".sheet-floating-layer") as HTMLElement;
  await user.click(textbox);
  return { dialog, host, onChange, textbox, user };
}

function lastDoc(onChange: ReturnType<typeof vi.fn>): DocumentNodeJSON {
  return onChange.mock.calls.at(-1)?.[0] as DocumentNodeJSON;
}

function firstBlock(doc: DocumentNodeJSON): NonNullable<DocumentNodeJSON["content"]>[number] {
  const block = doc.content?.[0];
  if (block === undefined) {
    throw new Error("expected a first block");
  }
  return block;
}

// Place a real, non-empty DOM selection over the paragraph text and let ProseMirror sync it, flipping
// the BubbleMenu's shouldShow gate — the same mechanism a reader triggers by dragging a selection.
function selectParagraph(textbox: HTMLElement, start: number, end: number): void {
  const textNode = textbox.querySelector("p")?.firstChild as Text | null | undefined;
  if (textNode === null || textNode === undefined) {
    throw new Error("Expected a paragraph text node to select.");
  }
  const selection = window.getSelection();
  const range = window.document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  selection?.removeAllRanges();
  selection?.addRange(range);
  window.document.dispatchEvent(new Event("selectionchange"));
}

describe("RichContentEditor inside a Sheet (#645)", () => {
  it("mounts the editor in the dialog and exposes an above-overlay floating host", async () => {
    const { dialog, host } = await mountEditorInSheet();

    expect(host).not.toBeNull();
    expect(dialog.contains(host)).toBe(true);
    // The host must not be caught by Radix's aria-hidden sweep, or the surfaces inside it go inert.
    expect(host.closest("[aria-hidden='true']")).toBeNull();
  });

  it("portals the slash menu into the sheet host and keeps filter, navigation, and selection working", async () => {
    const { host, onChange, textbox, user } = await mountEditorInSheet();
    const idBefore = textbox.querySelector("p")?.getAttribute("data-id");

    await user.type(textbox, "/");
    const listbox = await waitFor(() => {
      const found = within(host).getByRole("listbox");
      return found;
    });

    // The crux: the menu portals INTO the sheet host, not the body-level portal the modal renders inert.
    expect(host.contains(listbox)).toBe(true);

    // Filtering narrows the list in place.
    await user.type(textbox, "H2");
    await waitFor(() =>
      expect(
        within(host)
          .getAllByRole("option")
          .map((option) => option.textContent)
      ).toEqual(["Heading 2"])
    );

    // Keyboard navigation + Enter selects and transforms, preserving the block id and removing the query.
    await user.keyboard("{Enter}");
    await waitFor(() => expect(firstBlock(lastDoc(onChange)).type).toBe("heading"));
    expect(firstBlock(lastDoc(onChange)).attrs?.["level"]).toBe(2);
    expect(firstBlock(lastDoc(onChange)).attrs?.["id"]).toBe(idBefore);
    expect(textbox.textContent).toBe("");
  });

  it("navigates the sheet-hosted slash menu with Arrow keys before selecting", async () => {
    const { host, onChange, textbox, user } = await mountEditorInSheet();

    await user.type(textbox, "/");
    await waitFor(() => expect(within(host).queryByRole("listbox")).not.toBeNull());
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    await waitFor(() => expect(firstBlock(lastDoc(onChange)).type).toBe("heading"));
    expect(firstBlock(lastDoc(onChange)).attrs?.["level"]).toBe(2);
  });

  it("closes the sheet-hosted slash menu on Escape, leaving the slash literal", async () => {
    const { host, textbox, user } = await mountEditorInSheet();

    await user.type(textbox, "/");
    await waitFor(() => expect(within(host).queryByRole("listbox")).not.toBeNull());
    await user.keyboard("{Escape}");

    await waitFor(() => expect(within(host).queryByRole("listbox")).toBeNull());
    expect(textbox.textContent).toBe("/");
  });

  it("undoes a sheet-hosted slash transform in one step", async () => {
    const { onChange, textbox, user } = await mountEditorInSheet();

    await user.type(textbox, "/");
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(firstBlock(lastDoc(onChange)).type).toBe("heading"));

    textbox.focus();
    await user.keyboard("{Control>}z{/Control}");

    // A single undo reverts the slash transform in one step: the heading returns to a paragraph. (The
    // slash text's recovery depends on ProseMirror's history-grouping window, which is timing-sensitive
    // under parallel load and orthogonal to #645, so the block-type revert is the stable oracle here.)
    await waitFor(() => expect(firstBlock(lastDoc(onChange)).type).toBe("paragraph"));
  });

  it("keeps the slash literal in a code block hosted in the sheet", async () => {
    const { host, textbox, user } = await mountEditorInSheet(codeBlockDoc);

    await user.type(textbox, "/");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(within(host).queryByRole("listbox")).toBeNull();
    expect(textbox.textContent).toContain("/");
  });

  it("portals the formatting toolbar into the sheet host, with roving focus, and applies a mark", async () => {
    const { host, onChange, textbox, user } = await mountEditorInSheet(paragraph("Format me"));

    textbox.focus();
    selectParagraph(textbox, 0, 6);
    const toolbar = await within(host).findByRole("toolbar", { name: "Text formatting" });
    expect(host.contains(toolbar)).toBe(true);

    // Roving focus: Arrow keys move focus across the toolbar's controls (one tab stop).
    const bold = within(toolbar).getByRole("button", { name: "Bold" });
    bold.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(within(toolbar).getByRole("button", { name: "Italic" }));

    await user.click(bold);
    await waitFor(() =>
      expect(lastDoc(onChange).content?.[0]?.content?.[0]?.marks?.[0]?.type).toBe("bold")
    );
  });

  it("portals the link form into the sheet host and applies a normalized link", async () => {
    const { host, onChange, textbox, user } = await mountEditorInSheet(paragraph("Format me"));

    textbox.focus();
    selectParagraph(textbox, 0, 6);
    const toolbar = await within(host).findByRole("toolbar", { name: "Text formatting" });

    await user.click(within(toolbar).getByRole("button", { name: "Link" }));
    const input = await within(host).findByRole("textbox", { name: "Link URL" });
    expect(host.contains(input)).toBe(true);

    await user.type(input, "https://example.com");
    await user.click(within(host).getByRole("button", { name: "Apply link" }));

    await waitFor(() => {
      const marks = lastDoc(onChange).content?.[0]?.content?.[0]?.marks ?? [];
      expect(marks.some((mark) => mark.type === "link")).toBe(true);
    });
  });

  it("portals the block-actions menu into the sheet host", async () => {
    const { host, user } = await mountEditorInSheet(paragraph("Format me"));

    await user.click(screen.getByRole("button", { name: "More block actions" }));
    const menu = await within(host).findByRole("menu", { name: "More block actions" });

    expect(host.contains(menu)).toBe(true);
    expect(within(menu).getByText("Delete")).toBeDefined();
  });
});
