// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useReaderScroll } from "./useReaderScroll.js";

function setViewport(scrollHeight: number, innerHeight: number): void {
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    value: scrollHeight
  });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: innerHeight });
}

function scrollTo(scrollY: number): void {
  Object.defineProperty(window, "scrollY", { configurable: true, value: scrollY });
  act(() => {
    window.dispatchEvent(new Event("scroll"));
  });
}

afterEach(() => {
  Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
});

describe("useReaderScroll", () => {
  it("hides the header on scroll down past the threshold and tracks progress", () => {
    setViewport(1000, 400); // max scrollable distance = 600
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });

    const { result } = renderHook(() => useReaderScroll());
    expect(result.current).toEqual({ headerHidden: false, progress: 0 });

    // Down but below the hide threshold: header stays visible.
    scrollTo(50);
    expect(result.current.headerHidden).toBe(false);

    // Down past the threshold: header hides; progress = 300 / 600.
    scrollTo(300);
    expect(result.current.headerHidden).toBe(true);
    expect(result.current.progress).toBeCloseTo(0.5);

    // Up: header reappears.
    scrollTo(100);
    expect(result.current.headerHidden).toBe(false);
  });

  it("clamps progress to 1 and reports 0 when the document does not overflow", () => {
    setViewport(1000, 400);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    const { result } = renderHook(() => useReaderScroll());

    scrollTo(5000);
    expect(result.current.progress).toBe(1);

    setViewport(300, 400); // max <= 0
    scrollTo(10);
    expect(result.current.progress).toBe(0);
  });
});
