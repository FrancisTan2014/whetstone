// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BlockContent } from "./mdastBlock";

afterEach(() => {
  cleanup();
});

describe("BlockContent", () => {
  it("underlines a note's anchored range when marks are supplied", () => {
    const { container } = render(
      <BlockContent
        marks={[
          {
            ariaLabel: "Note on 'brown'",
            className: "noteMark--vocab",
            endOffset: 7,
            noteId: "n1",
            startOffset: 2
          }
        ]}
        node={{ children: [{ type: "text", value: "A brown fox." }], type: "paragraph" }}
      />
    );

    const mark = container.querySelector(".noteMark") as HTMLElement;
    expect(mark.textContent).toBe("brown");
    expect(mark.getAttribute("data-note-id")).toBe("n1");
    expect(mark.getAttribute("aria-label")).toBe("Note on 'brown'");
    // The mark span survives sanitize (applied after it) with its interactive attributes intact.
    expect(mark.getAttribute("role")).toBe("button");
  });

  it("renders a heading from stored mdast without re-parsing Markdown", () => {
    render(
      <BlockContent
        node={{ children: [{ type: "text", value: "Title" }], depth: 2, type: "heading" }}
      />
    );

    expect(screen.getByRole("heading", { level: 2, name: "Title" })).toBeDefined();
  });

  it("renders a list as a real list with items", () => {
    const { container } = render(
      <BlockContent
        node={{
          children: [
            {
              children: [{ children: [{ type: "text", value: "one" }], type: "paragraph" }],
              type: "listItem"
            },
            {
              children: [{ children: [{ type: "text", value: "two" }], type: "paragraph" }],
              type: "listItem"
            }
          ],
          ordered: false,
          type: "list"
        }}
      />
    );

    const list = container.querySelector("ul") as HTMLElement;
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list.textContent).toContain("one");
  });

  it("renders in-content links as non-navigating readerLink spans (no anchor)", () => {
    const { container } = render(
      <BlockContent
        node={{
          children: [
            { children: [{ type: "text", value: "ref" }], type: "link", url: "chapter2.xhtml" }
          ],
          type: "paragraph"
        }}
      />
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("span.readerLink")?.textContent).toBe("ref");
  });

  it("renders a list item whose link wraps a nested list with valid nesting (no <li> inside inline/<li>)", () => {
    const errors: unknown[][] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args);
    });

    // Offending EPUB shape: an `<a>` wrapping block content (text + a nested list) inside a
    // list item. Rendered naively this puts a `<li>` inside the inline readerLink `<span>`,
    // which is invalid HTML and triggers React's "<li> cannot be a descendant of <li>" error.
    const { container } = render(
      <BlockContent
        node={{
          children: [
            {
              children: [
                {
                  children: [
                    { type: "text", value: "parent" },
                    {
                      children: [
                        { children: [{ type: "text", value: "child" }], type: "listItem" }
                      ],
                      ordered: false,
                      type: "list"
                    }
                  ],
                  type: "link",
                  url: "chapter2.xhtml"
                }
              ],
              type: "listItem"
            }
          ],
          ordered: false,
          type: "list"
        }}
      />
    );

    consoleError.mockRestore();

    // Every list item sits directly inside its list container — never inside an inline element
    // or another <li>.
    const items = Array.from(container.querySelectorAll("li"));
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.parentElement?.tagName).toMatch(/^(UL|OL)$/);
    }

    // The non-navigating readerLink span never wraps block content.
    for (const link of Array.from(container.querySelectorAll("span.readerLink"))) {
      expect(link.querySelector("li, ul, ol, p")).toBeNull();
    }

    // The nested structure and its text are preserved.
    const nested = container.querySelector("ul ul") as HTMLElement;
    expect(nested).not.toBeNull();
    expect(container.textContent).toContain("parent");
    expect(nested.textContent).toContain("child");

    // No DOM-nesting / hydration warning was emitted.
    const nestingWarnings = errors.filter((args) =>
      /cannot be a (descendant|child)|hydrat/i.test(args.map(String).join(" "))
    );
    expect(nestingWarnings).toHaveLength(0);
  });

  it("renders a listItem whose link wraps bare list items with valid nesting (no <li> inside <li>)", () => {
    const errors: unknown[][] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args);
    });

    // The #162 EPUB shape: a `link` whose children are bare `listItem`s sits inside a `listItem`.
    // Rendered naively this puts a `<li>` directly inside a `<li>` (invalid HTML, hydration error).
    const { container } = render(
      <BlockContent
        node={{
          children: [
            {
              children: [
                {
                  children: [
                    { children: [{ type: "text", value: "one" }], type: "listItem" },
                    { children: [{ type: "text", value: "two" }], type: "listItem" }
                  ],
                  type: "link",
                  url: "chapter2.xhtml"
                }
              ],
              type: "listItem"
            }
          ],
          ordered: false,
          type: "list"
        }}
      />
    );

    consoleError.mockRestore();

    // Every list item sits directly inside a list container — never inside another <li>.
    const items = Array.from(container.querySelectorAll("li"));
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.parentElement?.tagName).toMatch(/^(UL|OL)$/);
    }

    expect(container.textContent).toContain("one");
    expect(container.textContent).toContain("two");

    const nestingWarnings = errors.filter((args) =>
      /cannot be a (descendant|child)|hydrat/i.test(args.map(String).join(" "))
    );
    expect(nestingWarnings).toHaveLength(0);
  });

  it("renders a GFM table as a real table with header and body cells", () => {
    const { container } = render(
      <BlockContent
        node={{
          align: [null, null],
          children: [
            {
              children: [
                { children: [{ type: "text", value: "Term" }], type: "tableCell" },
                { children: [{ type: "text", value: "Meaning" }], type: "tableCell" }
              ],
              type: "tableRow"
            },
            {
              children: [
                { children: [{ type: "text", value: "whetstone" }], type: "tableCell" },
                { children: [{ type: "text", value: "sharpening surface" }], type: "tableCell" }
              ],
              type: "tableRow"
            }
          ],
          type: "table"
        }}
      />
    );

    expect(container.querySelector("table")).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "Term" })).toBeDefined();
    expect(screen.getByRole("columnheader", { name: "Meaning" })).toBeDefined();
    expect(screen.getByRole("cell", { name: "whetstone" })).toBeDefined();
    expect(screen.getByRole("cell", { name: "sharpening surface" })).toBeDefined();
  });

  it("drops raw HTML so it never executes (no script, no img)", () => {
    const { container } = render(
      <BlockContent
        node={{ type: "html", value: "<script>window.__x = 1;</script><img src='x'>" }}
      />
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).not.toContain("__x");
  });
});
