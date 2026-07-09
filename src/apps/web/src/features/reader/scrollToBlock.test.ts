// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { scrollToBlock } from "./scrollToBlock";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("scrollToBlock", () => {
  it("scrolls the matching block into view and focuses it", () => {
    const block = document.createElement("div");
    block.setAttribute("data-block-id", "block-1");
    block.tabIndex = 0;
    document.body.append(block);
    const scrollIntoView = vi.fn();
    block.scrollIntoView = scrollIntoView;

    scrollToBlock("block-1");

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(document.activeElement).toBe(block);
  });

  it("prefers the element-precise anchor element over the block top when an anchorId is given", () => {
    const block = document.createElement("div");
    block.setAttribute("data-block-id", "block-1");
    block.tabIndex = 0;
    const heading = document.createElement("h3");
    heading.setAttribute("data-anchor-id", "nested-target");
    heading.tabIndex = 0;
    block.append(heading);
    document.body.append(block);
    const blockScroll = vi.fn();
    const headingScroll = vi.fn();
    block.scrollIntoView = blockScroll;
    heading.scrollIntoView = headingScroll;

    scrollToBlock("block-1", "nested-target");

    // The nested element is the scroll+focus target, not the block top.
    expect(headingScroll).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(blockScroll).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(heading);
  });

  it("falls back to the block top when the anchor element is absent", () => {
    const block = document.createElement("div");
    block.setAttribute("data-block-id", "block-1");
    block.tabIndex = 0;
    document.body.append(block);
    const blockScroll = vi.fn();
    block.scrollIntoView = blockScroll;

    scrollToBlock("block-1", "missing-anchor");

    expect(blockScroll).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(document.activeElement).toBe(block);
  });

  it("does nothing when no block matches", () => {
    expect(() => scrollToBlock("missing")).not.toThrow();
  });

  it("uses CSS.escape for the selector when it is available", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "CSS");
    const escape = vi.fn((value: string) => value.replace(/["\\]/gu, "\\$&"));
    // jsdom exposes `CSS` without `escape`; provide it so the CSS.escape path (the browser path) runs.
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: { escape } });
    try {
      const block = document.createElement("div");
      block.setAttribute("data-block-id", "block-1");
      block.tabIndex = 0;
      document.body.append(block);
      const scrollIntoView = vi.fn();
      block.scrollIntoView = scrollIntoView;

      scrollToBlock("block-1");

      expect(escape).toHaveBeenCalledWith("block-1");
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
      expect(document.activeElement).toBe(block);
    } finally {
      if (original === undefined) {
        delete (globalThis as { CSS?: unknown }).CSS;
      } else {
        Object.defineProperty(globalThis, "CSS", original);
      }
    }
  });

  it("falls back to a manual attribute escape when CSS is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "CSS");
    // An older jsdom / non-DOM host with no `CSS` global at all: the manual escape must handle the
    // selector. The id carries a quote so an unescaped selector would be malformed.
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: undefined });
    try {
      const block = document.createElement("div");
      block.setAttribute("data-block-id", 'blk"1');
      block.tabIndex = 0;
      document.body.append(block);
      const scrollIntoView = vi.fn();
      block.scrollIntoView = scrollIntoView;

      scrollToBlock('blk"1');

      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
      expect(document.activeElement).toBe(block);
    } finally {
      if (original === undefined) {
        delete (globalThis as { CSS?: unknown }).CSS;
      } else {
        Object.defineProperty(globalThis, "CSS", original);
      }
    }
  });
});
