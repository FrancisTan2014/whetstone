// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { rangeWithinElement } from "./blockText";
import { textQuoteRange, wrapRange } from "./textHighlight";

afterEach(() => {
  document.body.innerHTML = "";
});

function root(html: string): HTMLElement {
  const element = document.createElement("div");
  element.innerHTML = html;
  document.body.append(element);

  return element;
}

const attributes = {
  "aria-label": "Note on 'x'",
  class: "noteMark noteMark--violet",
  "data-note-id": "n1",
  role: "button",
  tabindex: "0"
};

function spans(container: Element): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("span.noteMark"));
}

describe("textQuoteRange", () => {
  it("locates the only occurrence when no context is given", () => {
    const element = root("simple text here");

    const range = textQuoteRange(element, { exact: "text", prefix: "", suffix: "" });

    expect(range?.toString()).toBe("text");
    expect(range?.startOffset).toBe(7);
  });

  it("disambiguates a repeated phrase by its preceding prefix", () => {
    const element = root("one fox two fox three");

    // "fox" occurs at 4 and 12; the prefix "two " uniquely precedes the second.
    const range = textQuoteRange(element, { exact: "fox", prefix: "two ", suffix: "" });

    expect(range?.toString()).toBe("fox");
    expect(range?.startOffset).toBe(12);
  });

  it("disambiguates by suffix and keeps the better earlier match over a later weaker one", () => {
    const element = root("fox one fox two");

    // "fox" occurs at 0 and 8; only the first is followed by " one", so it scores higher and the
    // later occurrence does not displace it.
    const range = textQuoteRange(element, { exact: "fox", prefix: "", suffix: " one" });

    expect(range?.toString()).toBe("fox");
    expect(range?.startOffset).toBe(0);
  });

  it("returns undefined when the exact text is absent", () => {
    const element = root("nothing to find here");

    expect(textQuoteRange(element, { exact: "absent", prefix: "", suffix: "" })).toBeUndefined();
  });
});

describe("wrapRange", () => {
  it("wraps a range within a single text node and restores it on removal", () => {
    const element = root("First block text.");
    const range = rangeWithinElement(element, 6, 11) as Range;

    const remove = wrapRange(range, attributes);

    const wrapped = spans(element);
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]?.textContent).toBe("block");
    expect(wrapped[0]?.getAttribute("data-note-id")).toBe("n1");
    expect(wrapped[0]?.className).toBe("noteMark noteMark--violet");

    remove();
    expect(spans(element)).toHaveLength(0);
    expect(element.textContent).toBe("First block text.");
  });

  it("wraps each text node of a range crossing inline-element boundaries", () => {
    const element = root("x<em>ab</em>cd<em>ef</em>y");
    // Highlight "bcde" — it starts mid-"ab", spans the whole "cd" node, and ends mid-"ef", with a
    // leading "x" node outside the range.
    const range = rangeWithinElement(element, 2, 6) as Range;

    const remove = wrapRange(range, attributes);

    const wrapped = spans(element);
    expect(wrapped.map((span) => span.textContent)).toEqual(["b", "cd", "e"]);

    remove();
    expect(spans(element)).toHaveLength(0);
    expect(element.textContent).toBe("xabcdefy");
  });

  it("skips an empty boundary slice when the range starts at a text-node edge", () => {
    const element = root("ab<em>cd</em>");
    // The range [2,4) starts exactly at the end of the "ab" node, so its leading slice is empty and
    // only the "cd" node is wrapped.
    const range = rangeWithinElement(element, 2, 4) as Range;

    const remove = wrapRange(range, attributes);

    const wrapped = spans(element);
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]?.textContent).toBe("cd");

    remove();
    expect(element.textContent).toBe("abcd");
  });
});
