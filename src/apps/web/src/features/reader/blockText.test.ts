// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { blockTextContent, rangeWithinElement, textOffsetOf } from "./blockText";

afterEach(() => {
  document.body.innerHTML = "";
});

function blockWith(html: string): HTMLElement {
  const element = document.createElement("div");
  element.innerHTML = html;
  document.body.append(element);

  return element;
}

describe("blockTextContent", () => {
  it("returns the element's rendered text", () => {
    expect(blockTextContent(blockWith("A <em>brown</em> fox."))).toBe("A brown fox.");
  });

  it("returns an empty string for an element with no text", () => {
    const empty = document.createElement("div");

    expect(blockTextContent(empty)).toBe("");
  });
});

describe("textOffsetOf", () => {
  it("counts the characters before a point, across inline children", () => {
    const block = blockWith("A <em>brown</em> fox.");
    const emphasis = block.querySelector("em") as HTMLElement;
    const innerText = emphasis.firstChild as Text;

    // The point sits two characters into "brown", which follows the leading "A ".
    expect(textOffsetOf(block, innerText, 2)).toBe(4);
  });

  it("resolves an element-boundary point by child index", () => {
    const block = blockWith("A <em>brown</em> fox.");

    // Child index 1 is the <em>, so the offset is the length of the preceding "A ".
    expect(textOffsetOf(block, block, 1)).toBe(2);
  });
});

describe("rangeWithinElement", () => {
  it("covers exactly the requested character span", () => {
    const block = blockWith("A brown fox.");

    const range = rangeWithinElement(block, 2, 7);

    expect(range?.toString()).toBe("brown");
  });

  it("spans a sub-range that crosses an inline element boundary", () => {
    const block = blockWith("A <em>brown</em> fox.");

    const range = rangeWithinElement(block, 0, 7);

    expect(range?.toString()).toBe("A brown");
  });

  it("addresses the block's very end (offset === length)", () => {
    const block = blockWith("A brown fox.");

    const range = rangeWithinElement(block, 0, "A brown fox.".length);

    expect(range?.toString()).toBe("A brown fox.");
  });

  it("returns undefined for a negative start", () => {
    expect(rangeWithinElement(blockWith("text"), -1, 2)).toBeUndefined();
  });

  it("returns undefined when the end precedes the start", () => {
    expect(rangeWithinElement(blockWith("text"), 3, 1)).toBeUndefined();
  });

  it("returns undefined when the end runs past the rendered text", () => {
    expect(rangeWithinElement(blockWith("short"), 0, 99)).toBeUndefined();
  });

  it("returns undefined when the start runs past the rendered text", () => {
    expect(rangeWithinElement(blockWith("short"), 99, 100)).toBeUndefined();
  });
});
