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
});
