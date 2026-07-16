// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor, Extensions } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { type DocumentNodeJSON, documentExtensions } from "@whetstone/document";
import { useEffect, useRef } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { EditorFormattingMenu } from "./EditorFormattingMenu";

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
    value: () => {}
  });
});

afterEach(() => {
  cleanup();
});

const paragraph = (content: DocumentNodeJSON[]): DocumentNodeJSON => ({
  content: [{ content, type: "paragraph" }],
  type: "doc"
});

const plainDocument = paragraph([{ text: "Format me", type: "text" }]);
const boldDocument = paragraph([{ marks: [{ type: "bold" }], text: "Bold text", type: "text" }]);
const linkedDocument = paragraph([
  {
    marks: [{ attrs: { href: "https://example.com" }, type: "link" }],
    text: "Linked",
    type: "text"
  }
]);
const codeBlockDocument: DocumentNodeJSON = {
  content: [{ content: [{ text: "const x = 1;", type: "text" }], type: "codeBlock" }],
  type: "doc"
};

function Harness({
  document,
  container,
  onEscape = () => {},
  onReady
}: {
  document: DocumentNodeJSON;
  container?: () => HTMLElement;
  onEscape?: () => void;
  onReady?: (editor: Editor) => void;
}): React.JSX.Element | null {
  const readyRef = useRef(false);
  const editor = useEditor({
    content: document,
    editorProps: {
      attributes: { "aria-label": "Rich content editor", "aria-multiline": "true", role: "textbox" }
    },
    extensions: documentExtensions as unknown as Extensions,
    immediatelyRender: false,
    shouldRerenderOnTransaction: true
  });

  useEffect(() => {
    if (editor === null || readyRef.current) {
      return;
    }

    readyRef.current = true;
    editor.commands.selectAll();
    onReady?.(editor);
  }, [editor, onReady]);

  if (editor === null) {
    return null;
  }

  return (
    <>
      <EditorFormattingMenu
        editor={editor}
        onEscape={onEscape}
        {...(container === undefined ? {} : { container })}
      />
      <EditorContent editor={editor} />
    </>
  );
}

async function renderMenu(
  document: DocumentNodeJSON,
  options: { container?: () => HTMLElement; onEscape?: () => void } = {}
): Promise<{ editor: Editor; toolbar: HTMLElement; user: ReturnType<typeof userEvent.setup> }> {
  let editor: Editor | undefined;
  const user = userEvent.setup();
  const onEscape = options.onEscape ?? (() => {});
  render(
    <Harness
      document={document}
      onEscape={onEscape}
      onReady={(e) => (editor = e)}
      {...(options.container === undefined ? {} : { container: options.container })}
    />
  );
  const toolbar = await screen.findByRole("toolbar", { name: "Text formatting" });
  await waitFor(() => expect(editor).toBeDefined());
  return { editor: editor as Editor, toolbar, user };
}

describe("EditorFormattingMenu marks", () => {
  it("derives pressed state from the live selection", async () => {
    const { toolbar } = await renderMenu(boldDocument);

    expect(within(toolbar).getByRole("button", { name: "Bold" }).getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect(
      within(toolbar).getByRole("button", { name: "Italic" }).getAttribute("aria-pressed")
    ).toBe("false");
  });

  it("disables marks the selection cannot accept", async () => {
    const { toolbar } = await renderMenu(codeBlockDocument);

    expect(
      (within(toolbar).getByRole("button", { name: "Bold" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (within(toolbar).getByRole("button", { name: "Link" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("does not open the link form for a selection that cannot accept a link", async () => {
    const { toolbar, user } = await renderMenu(codeBlockDocument);

    await user.click(within(toolbar).getByRole("button", { name: "Link" }));

    expect(screen.queryByRole("dialog", { name: "Link URL" })).toBeNull();
  });

  it("applies a mark and preserves the selection so another command can follow", async () => {
    const { editor, toolbar, user } = await renderMenu(plainDocument);
    const before = { from: editor.state.selection.from, to: editor.state.selection.to };
    const markTypes = (): string[] =>
      (editor.getJSON().content?.[0]?.content?.[0]?.marks ?? []).map((mark) => mark.type);

    await user.click(within(toolbar).getByRole("button", { name: "Bold" }));
    await waitFor(() => expect(markTypes()).toContain("bold"));
    expect(editor.state.selection.from).toBe(before.from);
    expect(editor.state.selection.to).toBe(before.to);

    await user.click(within(toolbar).getByRole("button", { name: "Italic" }));
    await waitFor(() => expect(markTypes()).toContain("italic"));
    expect(markTypes()).toContain("bold");
  });
});

describe("EditorFormattingMenu roving focus", () => {
  it("moves focus across controls with the arrow, home, and end keys", async () => {
    const { toolbar, user } = await renderMenu(plainDocument);
    const bold = within(toolbar).getByRole("button", { name: "Bold" });
    const italic = within(toolbar).getByRole("button", { name: "Italic" });
    const link = within(toolbar).getByRole("button", { name: "Link" });

    bold.focus();
    expect(bold.tabIndex).toBe(0);
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(italic);
    expect(italic.tabIndex).toBe(0);
    expect(bold.tabIndex).toBe(-1);

    await user.keyboard("{End}");
    expect(document.activeElement).toBe(link);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(bold);
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(link);
  });

  it("ignores keys it does not manage", async () => {
    const { toolbar, user } = await renderMenu(plainDocument);
    const bold = within(toolbar).getByRole("button", { name: "Bold" });

    bold.focus();
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(bold);
    expect(bold.tabIndex).toBe(0);
  });

  it("closes on Escape and leaves the popover to own Escape while it is open", async () => {
    const onEscape = vi.fn();
    const { toolbar, user } = await renderMenu(plainDocument, { onEscape });
    const bold = within(toolbar).getByRole("button", { name: "Bold" });

    bold.focus();
    await user.keyboard("{Escape}");
    expect(onEscape).toHaveBeenCalledTimes(1);

    await user.click(within(toolbar).getByRole("button", { name: "Link" }));
    await screen.findByRole("dialog", { name: "Link URL" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Link URL" })).toBeNull());
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});

describe("EditorFormattingMenu link form", () => {
  it("prefills from the active link and applies a normalized URL", async () => {
    const { editor, toolbar, user } = await renderMenu(linkedDocument);

    await user.click(within(toolbar).getByRole("button", { name: "Link" }));
    const input = await screen.findByRole("textbox", { name: "Link URL" });
    expect((input as HTMLInputElement).value).toBe("https://example.com");

    await user.clear(input);
    await user.type(input, "example.org");
    await user.click(screen.getByRole("button", { name: "Apply link" }));

    await waitFor(() => expect(editor.getAttributes("link")["href"]).toBe("https://example.org"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Link URL" })).toBeNull());
  });

  it("surfaces an unsafe or malformed URL without losing the selection", async () => {
    const { editor, toolbar, user } = await renderMenu(plainDocument);

    await user.click(within(toolbar).getByRole("button", { name: "Link" }));
    const input = await screen.findByRole("textbox", { name: "Link URL" });
    await user.type(input, "javascript:alert(1)");
    await user.click(screen.getByRole("button", { name: "Apply link" }));

    expect(screen.getByRole("alert").textContent).toContain("http");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(editor.isActive("link")).toBe(false);
    expect(screen.getByRole("dialog", { name: "Link URL" })).toBeDefined();
  });

  it("removes an existing link", async () => {
    const { editor, toolbar, user } = await renderMenu(linkedDocument);

    await user.click(within(toolbar).getByRole("button", { name: "Link" }));
    await screen.findByRole("dialog", { name: "Link URL" });
    await user.click(screen.getByRole("button", { name: "Remove link" }));

    await waitFor(() => expect(editor.isActive("link")).toBe(false));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Link URL" })).toBeNull());
  });

  it("clears the link when the field is emptied and applied", async () => {
    const { editor, toolbar, user } = await renderMenu(linkedDocument);

    await user.click(within(toolbar).getByRole("button", { name: "Link" }));
    const input = await screen.findByRole("textbox", { name: "Link URL" });
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Apply link" }));

    await waitFor(() => expect(editor.isActive("link")).toBe(false));
  });

  it("inside a Sheet, portals the form into the container and ignores focus-outside so the dialog's focus trap cannot dismiss it", async () => {
    const host = window.document.createElement("div");
    window.document.body.appendChild(host);
    const outside = window.document.createElement("button");
    window.document.body.appendChild(outside);
    const { toolbar, user } = await renderMenu(linkedDocument, { container: () => host });

    await user.click(within(toolbar).getByRole("button", { name: "Link" }));
    const form = await screen.findByRole("dialog", { name: "Link URL" });
    // The link form portals into the provided host node (inside the Dialog), not document.body.
    expect(host.contains(form)).toBe(true);

    // The Dialog's focus trap moves focus outside the non-modal Popover as it opens; the portaled
    // guard must ignore that focus-outside so the form survives instead of self-dismissing.
    await act(async () => {
      outside.focus();
    });
    expect(screen.queryByRole("dialog", { name: "Link URL" })).not.toBeNull();

    host.remove();
    outside.remove();
  });

  it("standalone, keeps the link form inline in the bubble rather than portaling it elsewhere", async () => {
    const { toolbar, user } = await renderMenu(linkedDocument);

    await user.click(within(toolbar).getByRole("button", { name: "Link" }));
    const form = await screen.findByRole("dialog", { name: "Link URL" });
    // With no Sheet container the form stays inline next to the toolbar (no portal), unchanged.
    expect(form.closest('[role="toolbar"]')).not.toBeNull();
  });
});
