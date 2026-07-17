// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type DocumentNodeJSON, DocumentValidationError, documentText } from "@whetstone/document";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptyDocument } from "./editorDocument";
import { RichContentEditor } from "./RichContentEditor";

type DocumentListener = (document: DocumentNodeJSON) => void;

Object.defineProperty(document, "elementFromPoint", {
  configurable: true,
  value: () => null
});
Object.defineProperty(Range.prototype, "getBoundingClientRect", {
  configurable: true,
  value: () => new DOMRect()
});
Object.defineProperty(Range.prototype, "getClientRects", {
  configurable: true,
  value: () => [] as unknown as DOMRectList
});
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: () => {}
});
for (const method of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
  Object.defineProperty(HTMLElement.prototype, method, {
    configurable: true,
    value: () => (method === "hasPointerCapture" ? false : undefined)
  });
}

// The editor gates its pointer gutter on `(hover: hover) and (pointer: fine)`. Default every test to a
// coarse pointer (no gutter) so these cases exercise the always-available compact/keyboard path; the
// gutter-specific test overrides this to a fine pointer.
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

mockMatchMedia(false);

const textDocument = (text: string): DocumentNodeJSON => {
  const paragraph: DocumentNodeJSON =
    text === "" ? { type: "paragraph" } : { content: [{ text, type: "text" }], type: "paragraph" };

  return { content: [paragraph], type: "doc" };
};

const allNodesDocument: DocumentNodeJSON = {
  content: [
    {
      content: [
        { marks: [{ type: "bold" }], text: "bold", type: "text" },
        { marks: [{ type: "italic" }], text: "italic", type: "text" },
        { marks: [{ type: "code" }], text: "code", type: "text" },
        {
          marks: [{ attrs: { href: "https://example.com" }, type: "link" }],
          text: "link",
          type: "text"
        },
        {
          marks: [{ attrs: { anchor: "section" }, type: "link" }],
          text: "internal link",
          type: "text"
        },
        { attrs: { label: "1", refId: "fn-1" }, type: "footnoteMarker" }
      ],
      type: "paragraph"
    },
    { attrs: { level: 3 }, content: [{ text: "Heading", type: "text" }], type: "heading" },
    {
      content: [{ content: [{ text: "Quote", type: "text" }], type: "paragraph" }],
      type: "blockquote"
    },
    { content: [{ text: "const value = 1;", type: "text" }], type: "codeBlock" },
    {
      content: [
        {
          content: [{ content: [{ text: "Bullet", type: "text" }], type: "paragraph" }],
          type: "listItem"
        }
      ],
      type: "bulletList"
    },
    {
      content: [
        {
          content: [{ content: [{ text: "Number", type: "text" }], type: "paragraph" }],
          type: "listItem"
        }
      ],
      type: "orderedList"
    },
    {
      content: [
        {
          content: [
            {
              content: [{ content: [{ text: "Cell", type: "text" }], type: "paragraph" }],
              type: "tableCell"
            },
            {
              content: [{ content: [{ text: "Head", type: "text" }], type: "paragraph" }],
              type: "tableHeader"
            }
          ],
          type: "tableRow"
        }
      ],
      type: "table"
    },
    {
      content: [
        { attrs: { alt: "Diagram" }, type: "image" },
        { content: [{ text: "Caption", type: "text" }], type: "figureCaption" }
      ],
      type: "figure"
    },
    {
      content: [
        { content: [{ text: "Term", type: "text" }], type: "definitionTerm" },
        {
          content: [{ content: [{ text: "Definition", type: "text" }], type: "paragraph" }],
          type: "definitionDescription"
        }
      ],
      type: "definitionList"
    },
    {
      content: [{ content: [{ text: "Callout", type: "text" }], type: "paragraph" }],
      type: "callout"
    },
    {
      content: [{ content: [{ text: "Footnote", type: "text" }], type: "paragraph" }],
      type: "footnoteTarget"
    },
    { attrs: { html: "<custom>raw</custom>" }, type: "unknown" }
  ],
  type: "doc"
};

function lastDocument(mock: Mock<DocumentListener>): DocumentNodeJSON {
  const call = mock.mock.lastCall;

  if (call === undefined) {
    throw new Error("Expected the document listener to have been called.");
  }

  return call[0];
}

async function renderReady({
  ariaLabel = "Entry body",
  document = createEmptyDocument(),
  presentation = "full",
  withSave = true
}: {
  ariaLabel?: string;
  document?: DocumentNodeJSON;
  presentation?: "compact" | "full";
  withSave?: boolean;
} = {}) {
  const onChange = vi.fn<DocumentListener>();
  const onSave = vi.fn<DocumentListener>();
  const user = userEvent.setup();
  const view = render(
    <RichContentEditor
      ariaLabel={ariaLabel}
      document={document}
      onChange={onChange}
      presentation={presentation}
      {...(withSave ? { onSave } : {})}
    />
  );
  const textbox = await screen.findByRole("textbox", { name: ariaLabel });

  onChange.mockClear();
  onSave.mockClear();
  return { ...view, onChange, onSave, textbox, user };
}

// Drive the contextual toolbar the way a reader does: place a real, non-empty selection over the
// paragraph text and let ProseMirror sync it, which flips the BubbleMenu's shouldShow gate.
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

beforeEach(() => {
  // Default every case to a coarse pointer (no gutter); the gutter-reveal test opts into a fine one.
  mockMatchMedia(false);
});

afterEach(() => {
  cleanup();
});

describe("RichContentEditor boundary", () => {
  it("rejects invalid external JSON before creating an editor", () => {
    const invalid = { content: [{ type: "missing" }], type: "doc" } as DocumentNodeJSON;

    expect(() => render(<RichContentEditor document={invalid} onChange={vi.fn()} />)).toThrow(
      DocumentValidationError
    );
  });

  it("renders an explicit empty document and emits a validated immutable change", async () => {
    const { onChange, textbox, user } = await renderReady();

    expect(textbox.getAttribute("contenteditable")).toBe("true");
    expect(textbox.getAttribute("aria-multiline")).toBe("true");
    await user.click(textbox);
    await user.type(textbox, "A");

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const emitted = lastDocument(onChange);
    expect(documentText(emitted)).toBe("A");
    emitted.content?.[0]?.content?.splice(0);

    await user.type(textbox, "B");
    await waitFor(() => expect(documentText(lastDocument(onChange))).toBe("AB"));
  });

  it("renders read-only when not editable and re-enables editing when toggled back", async () => {
    const onChange = vi.fn<DocumentListener>();
    const user = userEvent.setup();
    const view = render(
      <RichContentEditor document={textDocument("Frozen")} editable={false} onChange={onChange} />
    );
    const textbox = await screen.findByRole("textbox", { name: "Rich content editor" });

    // Tiptap's native read-only: the content shows but the surface blocks edits.
    expect(textbox.getAttribute("contenteditable")).toBe("false");
    onChange.mockClear();
    await user.click(textbox);
    await user.type(textbox, "X");
    expect(onChange).not.toHaveBeenCalled();
    expect(textbox.textContent).toBe("Frozen");

    // The block-actions chrome — which runs mutating commands — is not mounted at all: no compact
    // trigger, and Shift+F10 opens no menu, so the document cannot be mutated through editor chrome.
    expect(screen.queryByRole("button", { name: "More block actions" })).toBeNull();
    fireEvent.keyDown(textbox, { key: "F10", shiftKey: true });
    expect(screen.queryByRole("menu", { name: "More block actions" })).toBeNull();

    // Toggling editable back on (the setEditable effect) restores an interactive surface and its chrome.
    view.rerender(<RichContentEditor document={textDocument("Frozen")} onChange={onChange} />);
    await waitFor(() => expect(textbox.getAttribute("contenteditable")).toBe("true"));
    expect(screen.getByRole("button", { name: "More block actions" })).toBeTruthy();
  });

  it("mounts no pointer drag-gutter on a read-only surface even under a fine pointer", async () => {
    mockMatchMedia(true);
    render(
      <RichContentEditor document={textDocument("Frozen")} editable={false} onChange={vi.fn()} />
    );
    await screen.findByRole("textbox", { name: "Rich content editor" });

    // A fine pointer would normally mount the drag-gutter; read-only mounts none of its mutating chrome.
    expect(window.document.querySelector(".richContentEditorGutter")).toBeNull();
    expect(screen.queryByRole("button", { name: "More block actions" })).toBeNull();
  });

  it("synchronizes a changed controlled document without emitting and ignores an equal clone", async () => {
    const first = textDocument("First");
    const second = textDocument("Second");
    const onChange = vi.fn<DocumentListener>();
    const view = render(<RichContentEditor document={first} onChange={onChange} />);
    const textbox = await screen.findByRole("textbox", { name: "Rich content editor" });

    onChange.mockClear();
    view.rerender(<RichContentEditor document={structuredClone(first)} onChange={onChange} />);
    expect(textbox.textContent).toBe("First");
    expect(onChange).not.toHaveBeenCalled();

    view.rerender(<RichContentEditor document={second} onChange={onChange} />);
    await waitFor(() => expect(textbox.textContent).toBe("Second"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("can render every valid document node and shared mark without exposing raw HTML", async () => {
    const { textbox } = await renderReady({ document: allNodesDocument });

    expect(textbox.querySelector("strong")?.textContent).toBe("bold");
    expect(textbox.querySelector("em")?.textContent).toBe("italic");
    expect(textbox.querySelector("p code")?.textContent).toBe("code");
    const links = textbox.querySelectorAll("a");
    expect(links[0]?.getAttribute("href")).toBe("https://example.com");
    expect(links[0]?.hasAttribute("inert")).toBe(false);
    expect(links[1]?.hasAttribute("href")).toBe(false);
    expect(links[1]?.hasAttribute("inert")).toBe(false);
    expect(textbox.querySelector("h3")?.textContent).toBe("Heading");
    expect(textbox.querySelector("blockquote")?.textContent).toBe("Quote");
    expect(textbox.querySelector("pre code")?.textContent).toBe("const value = 1;");
    expect(textbox.querySelector("ul li")?.textContent).toBe("Bullet");
    expect(textbox.querySelector("ol li")?.textContent).toBe("Number");
    expect(textbox.querySelector("table td")?.textContent).toBe("Cell");
    expect(textbox.querySelector("table th")?.textContent).toBe("Head");
    expect(textbox.querySelector("[data-pm-image]")?.textContent).toBe("Diagram");
    expect(textbox.querySelector("[data-pm-image]")?.getAttribute("aria-label")).toBe("Diagram");
    expect(textbox.querySelector("figcaption")?.textContent).toBe("Caption");
    expect(textbox.querySelector("dl")?.textContent).toContain("Definition");
    expect(textbox.querySelector("aside")?.textContent).toBe("Callout");
    expect(textbox.querySelector("sup")?.textContent).toBe("1");
    expect(textbox.querySelector("[data-pm-unknown]")?.textContent).toBe("<custom>raw</custom>");
    expect(textbox.querySelector("custom")).toBeNull();
  });

  it("uses safe fallback labels for non-string display attributes", async () => {
    const document: DocumentNodeJSON = {
      content: [
        {
          content: [
            { attrs: { label: 2 }, type: "footnoteMarker" },
            { text: "Text", type: "text" }
          ],
          type: "paragraph"
        },
        { content: [{ attrs: { alt: 3, id: 7 }, type: "image" }], type: "figure" },
        { content: [{ attrs: { alt: "" }, type: "image" }], type: "figure" },
        { attrs: { html: 4 }, type: "unknown" }
      ],
      type: "doc"
    };
    const { textbox } = await renderReady({ document });

    expect(textbox.querySelector("sup")?.textContent).toBe("");
    const images = textbox.querySelectorAll("[data-pm-image]");
    expect(images[0]?.textContent).toBe("Image");
    expect(images[0]?.getAttribute("aria-label")).toBe("Image");
    expect(images[0]?.hasAttribute("data-id")).toBe(false);
    expect(images[1]?.getAttribute("role")).toBe("presentation");
    expect(images[1]?.getAttribute("aria-hidden")).toBe("true");
    expect(textbox.querySelector("[data-pm-unknown]")?.textContent).toBe("");
  });
});

describe("RichContentEditor presentation", () => {
  it("renders a document-first surface with no permanent formatting chrome", async () => {
    const { container, textbox } = await renderReady({ document: textDocument("Draft") });

    expect(container.querySelector("[data-presentation='full']")).not.toBeNull();
    expect(textbox.textContent).toBe("Draft");
    // The contextual toolbar only exists beside a selection — the surface itself is chrome-free.
    expect(screen.queryByRole("toolbar", { name: "Text formatting" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Block style" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save document" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand editor" })).toBeNull();
  });

  it("marks the compact presentation on the root without altering the content", async () => {
    const { container, textbox } = await renderReady({
      document: textDocument("Note"),
      presentation: "compact"
    });

    expect(container.querySelector("[data-presentation='compact']")).not.toBeNull();
    expect(textbox.textContent).toBe("Note");
    expect(screen.queryByRole("toolbar", { name: "Text formatting" })).toBeNull();
  });
});

describe("RichContentEditor contextual formatting", () => {
  it("reveals the contextual toolbar beside a real selection and applies a mark", async () => {
    const { onChange, textbox, user } = await renderReady({ document: textDocument("Format me") });

    textbox.focus();
    selectParagraph(textbox, 0, 6);
    const toolbar = await screen.findByRole("toolbar", { name: "Text formatting" });

    await user.click(within(toolbar).getByRole("button", { name: "Bold" }));
    await waitFor(() =>
      expect(lastDocument(onChange).content?.[0]?.content?.[0]?.marks?.[0]?.type).toBe("bold")
    );
  });

  it("dismisses on Escape and returns for a different selection", async () => {
    const { textbox, user } = await renderReady({ document: textDocument("Format me") });

    textbox.focus();
    selectParagraph(textbox, 0, 6);
    const toolbar = await screen.findByRole("toolbar", { name: "Text formatting" });
    within(toolbar).getByRole("button", { name: "Bold" }).focus();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("toolbar", { name: "Text formatting" })).toBeNull()
    );

    selectParagraph(textbox, 2, 9);
    expect(await screen.findByRole("toolbar", { name: "Text formatting" })).toBeDefined();
  });
});

describe("RichContentEditor keyboard", () => {
  it.each([
    ["b", "bold", "Bold"],
    ["i", "italic", "Italic"],
    ["e", "code", "Code"]
  ])("applies the Ctrl+%s mark shortcut", async (key, mark, text) => {
    const { onChange, textbox, user } = await renderReady();

    await user.click(textbox);
    await user.keyboard(`{Control>}${key}{/Control}${text}`);

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(lastDocument(onChange).content?.[0]?.content?.[0]?.marks?.[0]?.type).toBe(mark);
  });

  it("undoes and redoes from the keyboard", async () => {
    const { onChange, textbox, user } = await renderReady();

    await user.click(textbox);
    await user.type(textbox, "A");
    await waitFor(() => expect(documentText(lastDocument(onChange))).toBe("A"));

    await user.keyboard("{Control>}z{/Control}");
    await waitFor(() => expect(documentText(lastDocument(onChange))).toBe(""));
    await user.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    await waitFor(() => expect(documentText(lastDocument(onChange))).toBe("A"));
  });
});

describe("RichContentEditor paste and save", () => {
  it("preserves supported rich marks and nested blocks when pasted", async () => {
    const { onChange, textbox } = await renderReady();

    textbox.focus();
    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === "text/html"
            ? '<h2>Rich <strong>bold</strong> <em>italic</em> <code>code</code> <a href="https://example.com">link</a></h2><ul><li><p>Item</p></li></ul>'
            : "Rich bold italic code link\nItem",
        items: [],
        types: ["text/html", "text/plain"]
      }
    });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const pasted = lastDocument(onChange);
    // ProseMirror merges the first pasted text block into the active empty paragraph; its inline
    // formatting survives, and subsequent block structure remains intact.
    expect(pasted.content?.[0]?.type).toBe("paragraph");
    expect(pasted.content?.[0]?.content?.[1]?.marks?.[0]?.type).toBe("bold");
    expect(pasted.content?.[0]?.content?.[7]?.marks?.[0]?.attrs?.["href"]).toBe(
      "https://example.com"
    );
    expect(pasted.content?.[1]?.type).toBe("bulletList");
  });

  it("turns pasted plain text into document paragraphs without interpreting markup", async () => {
    const { onChange, textbox } = await renderReady();

    textbox.focus();
    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === "text/plain" ? "First\n\n<strong>Second</strong>" : "",
        items: [],
        types: ["text/plain"]
      }
    });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const pasted = lastDocument(onChange);
    expect(pasted.content?.map((node) => node.type)).toEqual(["paragraph", "paragraph"]);
    expect(documentText(pasted)).toBe("First<strong>Second</strong>");
    expect(textbox.querySelector("strong")).toBeNull();
  });

  it("drops an unsafe pasted link mark while preserving its text", async () => {
    const { onChange, textbox } = await renderReady();

    textbox.focus();
    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === "text/html" ? '<p><a href="javascript:alert(1)">Keep me</a></p>' : "Keep me",
        items: [],
        types: ["text/html", "text/plain"]
      }
    });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(documentText(lastDocument(onChange))).toBe("Keep me");
    expect(lastDocument(onChange).content?.[0]?.content?.[0]?.marks).toBeUndefined();
    expect(textbox.querySelector("a")).toBeNull();
  });

  it("emits detached validated JSON from Ctrl/Meta+S without a Save button", async () => {
    const { onSave, textbox, user } = await renderReady();

    await user.click(textbox);
    await user.type(textbox, "Saved");
    textbox.focus();
    fireEvent.keyDown(textbox, { ctrlKey: true, key: "s" });
    const first = lastDocument(onSave);
    expect(documentText(first)).toBe("Saved");
    first.content?.[0]?.content?.splice(0);

    fireEvent.keyDown(textbox, { key: "S", metaKey: true });
    expect(documentText(lastDocument(onSave))).toBe("Saved");
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Save document" })).toBeNull();
  });

  it("does not claim the save shortcut or show a Save action without a consumer policy", async () => {
    const { textbox } = await renderReady({ withSave: false });
    const event = new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "s" });

    textbox.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("button", { name: "Save document" })).toBeNull();
  });
});

// Build a document of top-level paragraphs, each carrying a stable id so a reorder can be checked to
// preserve identity rather than re-create blocks.
function idParagraphs(...items: ReadonlyArray<{ id: string; text: string }>): DocumentNodeJSON {
  return {
    content: items.map(({ id, text }) => ({
      attrs: { id },
      content: [{ text, type: "text" }],
      type: "paragraph"
    })),
    type: "doc"
  };
}

const blockIds = (document: DocumentNodeJSON): Array<unknown> =>
  (document.content ?? []).map((node) => node.attrs?.["id"]);

const blockTexts = (document: DocumentNodeJSON): Array<string | undefined> =>
  (document.content ?? []).map((node) => node.content?.[0]?.text);

// Move the caret into a specific top-level block by collapsing the DOM selection inside its text and
// letting ProseMirror's selection observer sync — the same mechanism the contextual toolbar relies on.
async function placeCaretInBlock(textbox: HTMLElement, blockIndex: number): Promise<void> {
  const block = textbox.children.item(blockIndex);
  const textNode = block?.firstChild as Text | null | undefined;

  if (textNode === null || textNode === undefined) {
    throw new Error("Expected a top-level block text node to place the caret in.");
  }

  textbox.focus();
  const selection = window.getSelection();
  const range = window.document.createRange();
  range.setStart(textNode, 1);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
  window.document.dispatchEvent(new Event("selectionchange"));
  // Let ProseMirror's selection observer flush the DOM selection into editor state.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function openMoreMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "More block actions" }));
  return screen.findByRole("menu", { name: "More block actions" });
}

describe("RichContentEditor contextual block gutter", () => {
  it("opens the block-actions menu for the caret's block from the always-available compact trigger", async () => {
    const { user } = await renderReady({
      document: idParagraphs({ id: "a", text: "One" }, { id: "b", text: "Two" })
    });

    const menu = await openMoreMenu(user);

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

    // The caret starts in the first block, so Move up is at a boundary and Move down is not.
    expect(
      within(menu).getByRole("menuitem", { name: "Move up" }).getAttribute("aria-disabled")
    ).toBe("true");
    expect(
      within(menu).getByRole("menuitem", { name: "Move down" }).getAttribute("aria-disabled")
    ).not.toBe("true");
  });

  it("reorders the caret's block through the compact menu as one undo step, preserving its id", async () => {
    const { onChange, textbox, user } = await renderReady({
      document: idParagraphs({ id: "a", text: "One" }, { id: "b", text: "Two" })
    });

    const menu = await openMoreMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Move down" }));

    await waitFor(() => expect(blockTexts(lastDocument(onChange))).toEqual(["Two", "One"]));
    expect(blockIds(lastDocument(onChange))).toEqual(["b", "a"]);

    // The whole action is a single undoable edit.
    onChange.mockClear();
    textbox.focus();
    fireEvent.keyDown(textbox, { ctrlKey: true, key: "z" });
    await waitFor(() => expect(blockTexts(lastDocument(onChange))).toEqual(["One", "Two"]));
  });

  it("opens the menu for the caret's block with Shift+F10 and applies the action to that block", async () => {
    const { onChange, textbox } = await renderReady({
      document: idParagraphs(
        { id: "a", text: "One" },
        { id: "b", text: "Two" },
        { id: "c", text: "Three" }
      )
    });
    const user = userEvent.setup();

    await placeCaretInBlock(textbox, 1);
    fireEvent.keyDown(textbox, { key: "F10", shiftKey: true });

    const menu = await screen.findByRole("menu", { name: "More block actions" });
    // The caret is in the second block, so Move up is available (it is disabled on the first block).
    const moveUp = within(menu).getByRole("menuitem", { name: "Move up" });
    expect(moveUp.getAttribute("aria-disabled")).not.toBe("true");
    await user.click(moveUp);

    // Move up acts on the caret's block (the second), not the first, and keeps every id.
    await waitFor(() => expect(blockIds(lastDocument(onChange))).toEqual(["b", "a", "c"]));
    expect(blockTexts(lastDocument(onChange))).toEqual(["Two", "One", "Three"]);
  });

  it("washes the active block while its menu is open and clears the wash when dismissed", async () => {
    const { textbox, user } = await renderReady({
      document: idParagraphs({ id: "a", text: "One" }, { id: "b", text: "Two" })
    });

    expect(textbox.querySelector(".is-block-gutter-active")).toBeNull();

    await openMoreMenu(user);
    await waitFor(() =>
      expect(textbox.querySelector(".is-block-gutter-active")?.textContent).toBe("One")
    );

    await user.keyboard("{Escape}");
    await waitFor(() => expect(textbox.querySelector(".is-block-gutter-active")).toBeNull());
  });

  it("reveals the pointer drag-gutter grip only under a fine, hovering pointer", async () => {
    mockMatchMedia(true);
    await renderReady({ document: textDocument("One") });

    // The drag handle mounts its own gutter container (className) and renders the grip into it; the
    // grip is only positioned/interactive under a real pointer, so that reveal and its menu are
    // covered by the e2e. Here we assert the pointer gutter is wired up under a fine pointer.
    const gutter = window.document.querySelector(".richContentEditorGutter");
    expect(gutter).not.toBeNull();
    expect(within(gutter as HTMLElement).getByLabelText("Block actions")).toBeTruthy();
  });
});
