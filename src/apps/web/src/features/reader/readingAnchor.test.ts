// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { topmostVisibleBlockId } from "./readingAnchor";

function blockWithBottom(id: string, bottom: number): HTMLElement {
  const element = document.createElement("p");
  element.setAttribute("data-block-id", id);
  element.getBoundingClientRect = () => ({ bottom }) as DOMRect;

  return element;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("topmostVisibleBlockId", () => {
  it("returns the first block still in view, skipping blocks scrolled past the top", () => {
    const root = document.createElement("div");
    root.appendChild(blockWithBottom("b-1", -20));
    root.appendChild(blockWithBottom("b-2", 30));
    root.appendChild(blockWithBottom("b-3", 200));

    expect(topmostVisibleBlockId(root)).toBe("b-2");
  });

  it("returns undefined when every block is scrolled above the viewport top", () => {
    const root = document.createElement("div");
    root.appendChild(blockWithBottom("b-1", -50));
    root.appendChild(blockWithBottom("b-2", 0));

    expect(topmostVisibleBlockId(root)).toBeUndefined();
  });

  it("returns undefined when there are no blocks", () => {
    expect(topmostVisibleBlockId(document.createElement("div"))).toBeUndefined();
  });

  it("defaults to scanning the document", () => {
    document.body.appendChild(blockWithBottom("b-doc", 10));

    expect(topmostVisibleBlockId()).toBe("b-doc");
  });
});
