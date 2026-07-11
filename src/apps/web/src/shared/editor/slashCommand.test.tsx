// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DocumentNodeJSON } from "@whetstone/document";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { RichContentEditor } from "./RichContentEditor.js";

// jsdom lacks the layout primitives Tiptap's suggestion decoration and floating-ui positioning read;
// stub the few used so the managed menu mounts without throwing during measurement.
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
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
    writable: true
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

const emptyParagraph: DocumentNodeJSON = { content: [{ type: "paragraph" }], type: "doc" };
const emptyHeading: DocumentNodeJSON = {
  content: [{ attrs: { level: 2 }, type: "heading" }],
  type: "doc"
};
const codeBlockDoc: DocumentNodeJSON = {
  content: [{ content: [{ text: "let x = 1", type: "text" }], type: "codeBlock" }],
  type: "doc"
};

async function mountEditor(document: DocumentNodeJSON = emptyParagraph) {
  const onChange = vi.fn<(next: DocumentNodeJSON) => void>();
  const user = userEvent.setup();
  render(<RichContentEditor document={document} onChange={onChange} />);
  const textbox = await screen.findByRole("textbox", { name: "Rich content editor" });
  await user.click(textbox);
  return { onChange, textbox, user };
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

async function openMenu(textbox: HTMLElement, user: ReturnType<typeof userEvent.setup>) {
  await user.type(textbox, "/");
  await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeNull());
  return screen.getByRole("listbox");
}

function optionLabels(listbox: HTMLElement): string[] {
  return within(listbox)
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
}

describe("slash command menu integration", () => {
  it("opens a caret-anchored listbox of every command when a paragraph is empty", async () => {
    const { textbox, user } = await mountEditor();

    const listbox = await openMenu(textbox, user);

    expect(optionLabels(listbox)).toEqual([
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

  it("filters commands case-insensitively as the query grows", async () => {
    const { textbox, user } = await mountEditor();

    await openMenu(textbox, user);
    await user.type(textbox, "H1");

    await waitFor(() => expect(optionLabels(screen.getByRole("listbox"))).toEqual(["Heading 1"]));
  });

  it("transforms the block on Arrow+Enter, preserves its id, and removes the slash query", async () => {
    const { onChange, textbox, user } = await mountEditor();
    const idBefore = textbox.querySelector("p")?.getAttribute("data-id");

    await openMenu(textbox, user);
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    await waitFor(() => expect(firstBlock(lastDoc(onChange)).type).toBe("heading"));
    const heading = firstBlock(lastDoc(onChange));
    expect(heading.attrs?.["level"]).toBe(2);
    expect(heading.attrs?.["id"]).toBe(idBefore);
    expect(textbox.textContent).toBe("");
  });

  it("preserves the top-level block id when a wrapping command changes the block type", async () => {
    const { onChange, textbox, user } = await mountEditor();
    const idBefore = textbox.querySelector("p")?.getAttribute("data-id");
    expect(idBefore).toBeTruthy();

    const listbox = await openMenu(textbox, user);
    const quote = within(listbox)
      .getAllByRole("option")
      .find((option) => option.textContent === "Quote");
    await user.pointer({ keys: "[MouseLeft]", target: quote as HTMLElement });

    await waitFor(() => expect(firstBlock(lastDoc(onChange)).type).toBe("blockquote"));
    const blockquote = firstBlock(lastDoc(onChange));
    // The wrapping command builds a new top-level blockquote; it must inherit the block's stable id
    // so note anchors and the autosaved stable-id path keep addressing the same block (#588)...
    expect(blockquote.attrs?.["id"]).toBe(idBefore);
    // ...and the now-nested paragraph must not keep the same id, so the id addresses exactly one node.
    expect(blockquote.content?.[0]?.attrs?.["id"]).not.toBe(idBefore);
  });

  it("selects a command by pointer without losing the editor caret", async () => {
    const { onChange, textbox, user } = await mountEditor();

    const listbox = await openMenu(textbox, user);
    const quote = within(listbox)
      .getAllByRole("option")
      .find((option) => option.textContent === "Quote");
    await user.pointer({ keys: "[MouseLeft]", target: quote as HTMLElement });

    await waitFor(() => expect(firstBlock(lastDoc(onChange)).type).toBe("blockquote"));
    expect(document.activeElement).toBe(textbox);
  });

  it("closes on Escape and leaves the typed slash intact", async () => {
    const { textbox, user } = await mountEditor();

    await openMenu(textbox, user);
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(textbox.textContent).toBe("/");
  });

  it("closes on Tab and returns to normal editing", async () => {
    const { textbox, user } = await mountEditor();

    await openMenu(textbox, user);
    await user.keyboard("{Tab}");

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(textbox.textContent).toBe("/");
  });

  it("supports undo after a slash transform", async () => {
    const { onChange, textbox, user } = await mountEditor();

    await openMenu(textbox, user);
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(firstBlock(lastDoc(onChange)).type).toBe("heading"));

    // The fixed toolbar (and its Undo button) is gone as of #589; undo now runs from the keyboard.
    textbox.focus();
    await user.keyboard("{Control>}z{/Control}");

    await waitFor(() => expect(firstBlock(lastDoc(onChange)).type).toBe("paragraph"));
    expect(textbox.textContent).toBe("");
  });

  it("does not open inside a code block; the slash types literally", async () => {
    const { textbox, user } = await mountEditor(codeBlockDoc);

    await user.type(textbox, "/");

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(textbox.textContent).toContain("/");
  });

  it("shows the empty-paragraph hint only for a focused empty paragraph", async () => {
    const { textbox, user } = await mountEditor();
    expect(textbox.querySelector("p")?.getAttribute("data-placeholder")).toBe(
      "Type / for commands"
    );

    await user.type(textbox, "a");

    await waitFor(() =>
      expect(textbox.querySelector("p")?.getAttribute("data-placeholder")).not.toBe(
        "Type / for commands"
      )
    );
  });

  it("does not hint on an empty non-paragraph block", async () => {
    const { textbox } = await mountEditor(emptyHeading);

    expect(textbox.querySelector("h2")?.getAttribute("data-placeholder") ?? "").toBe("");
  });
});
