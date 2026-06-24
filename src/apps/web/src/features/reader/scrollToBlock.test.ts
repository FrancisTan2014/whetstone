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

  it("does nothing when no block matches", () => {
    expect(() => scrollToBlock("missing")).not.toThrow();
  });
});
