// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BlockContent } from "./mdastBlock";

afterEach(() => {
  cleanup();
});

describe("BlockContent", () => {
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
