// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type DocumentNodeJSON, DocumentValidationError, documentText } from "@whetstone/document";
import type { Mock } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("RichContentEditor presentations and accessibility", () => {
  it("keeps compact content intact while expanding the same editor to the full toolbar", async () => {
    const { container, onChange, textbox, user } = await renderReady({
      document: textDocument("Draft"),
      presentation: "compact"
    });

    expect(container.querySelector("[data-presentation='compact']")).not.toBeNull();
    expect(screen.queryByRole("combobox", { name: "Block style" })).toBeNull();
    expect(textbox.textContent).toBe("Draft");
    await user.click(screen.getByRole("button", { name: "Expand editor" }));

    expect(container.querySelector("[data-presentation='full']")).not.toBeNull();
    expect(screen.getByRole("combobox", { name: "Block style" })).toBeDefined();
    expect(textbox.textContent).toBe("Draft");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("starts full without an expand action and exposes labelled keyboard controls", async () => {
    const { textbox, user } = await renderReady();
    const toolbar = screen.getByRole("toolbar", { name: "Text formatting" });
    const bold = within(toolbar).getByRole("button", { name: "Bold" });

    expect(screen.queryByRole("button", { name: "Expand editor" })).toBeNull();
    expect(bold.getAttribute("aria-pressed")).toBe("false");
    expect(bold.className).toContain("min-h-11");
    expect(bold.className).toContain("min-w-11");
    for (const button of within(toolbar).getAllByRole("button")) {
      expect(button.className).toContain("min-h-11");
    }
    expect(screen.getByRole("combobox", { name: "Block style" }).className).toContain("min-h-11");
    expect(screen.getByRole("textbox", { name: "Link URL" }).className).toContain("min-h-11");

    bold.focus();
    await user.keyboard("{Enter}");
    expect(bold.getAttribute("aria-pressed")).toBe("true");
    expect(textbox.getAttribute("aria-label")).toBe("Entry body");
  });

  it("keeps the same usable controls under the Night theme", async () => {
    render(
      <div className="dark">
        <RichContentEditor document={createEmptyDocument()} onChange={vi.fn()} />
      </div>
    );

    expect(await screen.findByRole("textbox", { name: "Rich content editor" })).toBeDefined();
    expect(screen.getByRole("toolbar", { name: "Text formatting" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Bold" })).toBeDefined();
  });
});

describe("RichContentEditor formatting", () => {
  it.each([
    ["b", "bold", "Bold"],
    ["i", "italic", "Italic"],
    ["e", "code", "Code"]
  ])("supports the Ctrl+%s keyboard shortcut for %s", async (key, mark, text) => {
    const { onChange, textbox, user } = await renderReady();

    await user.click(textbox);
    await user.keyboard(`{Control>}${key}{/Control}${text}`);

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(lastDocument(onChange).content?.[0]?.content?.[0]?.marks?.[0]?.type).toBe(mark);
  });

  it.each([
    ["Heading 1", 1],
    ["Heading 2", 2],
    ["Heading 3", 3]
  ])("sets %s and can return it to a paragraph", async (option, level) => {
    const { onChange, textbox, user } = await renderReady();
    const select = screen.getByRole("combobox", { name: "Block style" });

    await user.selectOptions(select, option);
    await user.click(textbox);
    await user.type(textbox, "Title");
    await waitFor(() => expect(lastDocument(onChange).content?.[0]?.type).toBe("heading"));
    expect(lastDocument(onChange).content?.[0]?.attrs?.["level"]).toBe(level);
    expect((select as HTMLSelectElement).value).toBe(`heading-${level}`);

    await user.selectOptions(select, "Paragraph");
    await waitFor(() => expect(lastDocument(onChange).content?.[0]?.type).toBe("paragraph"));
  });

  it.each([
    ["Bullet list", "bulletList"],
    ["Ordered list", "orderedList"],
    ["Blockquote", "blockquote"],
    ["Code block", "codeBlock"]
  ])("toggles the %s block command", async (label, nodeType) => {
    const { onChange, textbox, user } = await renderReady();
    const button = screen.getByRole("button", { name: label });

    await user.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await user.click(textbox);
    await user.type(textbox, "Block");
    await waitFor(() => expect(lastDocument(onChange).content?.[0]?.type).toBe(nodeType));

    await user.click(button);
    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("false"));
  });

  it.each([
    ["Bold", "bold"],
    ["Italic", "italic"],
    ["Inline code", "code"]
  ])("toggles the %s toolbar mark", async (label, mark) => {
    const { onChange, textbox, user } = await renderReady();
    const button = screen.getByRole("button", { name: label });

    await user.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await user.click(textbox);
    await user.type(textbox, "Marked");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(lastDocument(onChange).content?.[0]?.content?.[0]?.marks?.[0]?.type).toBe(mark);
  });

  it("undoes and redoes from both toolbar buttons and keyboard shortcuts", async () => {
    const { onChange, textbox, user } = await renderReady();

    await user.click(textbox);
    await user.type(textbox, "A");
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(
        false
      )
    );
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(documentText(lastDocument(onChange))).toBe(""));
    await user.click(screen.getByRole("button", { name: "Redo" }));
    await waitFor(() => expect(documentText(lastDocument(onChange))).toBe("A"));

    await user.click(textbox);
    await user.keyboard("{Control>}z{/Control}");
    await waitFor(() => expect(documentText(lastDocument(onChange))).toBe(""));
    await user.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    await waitFor(() => expect(documentText(lastDocument(onChange))).toBe("A"));
  });
});

describe("RichContentEditor links, paste, and save", () => {
  it("validates link input, applies normalized links, and removes them", async () => {
    const { onChange, textbox, user } = await renderReady();
    const input = screen.getByRole("textbox", { name: "Link URL" });

    expect((input as HTMLInputElement).inputMode).toBe("url");
    await user.type(input, "javascript:alert(1)");
    await user.click(screen.getByRole("button", { name: "Apply link" }));
    expect(screen.getByRole("alert").textContent).toContain("http");
    expect(input.getAttribute("aria-invalid")).toBe("true");

    await user.clear(input);
    await user.type(input, "example.com");
    expect((input as HTMLInputElement).validity.valid).toBe(true);
    await user.click(screen.getByRole("button", { name: "Apply link" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(textbox);
    await user.type(textbox, "Linked");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(lastDocument(onChange).content?.[0]?.content?.[0]?.marks?.[0]?.attrs?.["href"]).toBe(
      "https://example.com"
    );

    await user.click(screen.getByRole("button", { name: "Remove link" }));
    await user.type(textbox, " plain");
    await waitFor(() => expect(documentText(lastDocument(onChange))).toBe("Linked plain"));
    expect(lastDocument(onChange).content?.[0]?.content?.[1]?.marks).toBeUndefined();

    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Apply link" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("removes the whole link mark when the caret is collapsed inside linked text", async () => {
    const linked: DocumentNodeJSON = {
      content: [
        {
          content: [
            {
              marks: [{ attrs: { href: "https://example.com" }, type: "link" }],
              text: "Linked text",
              type: "text"
            }
          ],
          type: "paragraph"
        }
      ],
      type: "doc"
    };
    const { onChange, textbox, user } = await renderReady({ document: linked });
    const linkedText = textbox.querySelector("a")?.firstChild;

    expect(linkedText).toBeInstanceOf(Text);
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(linkedText as Text, 3);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    await user.click(screen.getByRole("button", { name: "Remove link" }));
    await waitFor(() => expect(textbox.querySelector("a")).toBeNull());
    expect(lastDocument(onChange).content?.[0]?.content?.[0]?.marks).toBeUndefined();
  });

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

  it("emits detached validated JSON from the Save button and Ctrl/Meta+S", async () => {
    const { onSave, textbox, user } = await renderReady();

    await user.click(textbox);
    await user.type(textbox, "Saved");
    await user.click(screen.getByRole("button", { name: "Save document" }));
    const first = lastDocument(onSave);
    expect(documentText(first)).toBe("Saved");
    first.content?.[0]?.content?.splice(0);

    textbox.focus();
    fireEvent.keyDown(textbox, { ctrlKey: true, key: "s" });
    expect(documentText(lastDocument(onSave))).toBe("Saved");
    fireEvent.keyDown(textbox, { key: "S", metaKey: true });
    expect(onSave).toHaveBeenCalledTimes(3);
  });

  it("does not claim the save shortcut or show a Save action without a consumer policy", async () => {
    const { textbox } = await renderReady({ withSave: false });
    const event = new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "s" });

    textbox.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("button", { name: "Save document" })).toBeNull();
  });
});
