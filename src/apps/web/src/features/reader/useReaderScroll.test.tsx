// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useReaderScroll } from "./useReaderScroll.js";

// A stand-in scroll container: jsdom does not lay elements out, so scrollTop/scrollHeight/
// clientHeight are defined explicitly and a "scroll" event is dispatched to drive the hook.
function makeScroller(scrollHeight: number, clientHeight: number): HTMLDivElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: clientHeight });
  Object.defineProperty(element, "scrollTop", { configurable: true, writable: true, value: 0 });
  document.body.append(element);
  return element;
}

function scrollTo(element: HTMLElement, scrollTop: number): void {
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    writable: true,
    value: scrollTop
  });
  act(() => {
    element.dispatchEvent(new Event("scroll"));
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("useReaderScroll", () => {
  it("reports the neutral state when there is no scroll element", () => {
    const { result } = renderHook(() => useReaderScroll(null));
    expect(result.current).toEqual({ headerHidden: false, progress: 0 });
  });

  it("hides the header on scroll down past the threshold and tracks progress", () => {
    const element = makeScroller(1000, 400); // max scrollable distance = 600

    const { result } = renderHook(() => useReaderScroll(element));
    expect(result.current).toEqual({ headerHidden: false, progress: 0 });

    // Down but below the hide threshold: header stays visible.
    scrollTo(element, 50);
    expect(result.current.headerHidden).toBe(false);

    // Down past the threshold: header hides; progress = 300 / 600.
    scrollTo(element, 300);
    expect(result.current.headerHidden).toBe(true);
    expect(result.current.progress).toBeCloseTo(0.5);

    // Up: header reappears.
    scrollTo(element, 100);
    expect(result.current.headerHidden).toBe(false);
  });

  it("clamps progress to 1 and reports 0 when the content does not overflow", () => {
    const element = makeScroller(1000, 400);
    const { result } = renderHook(() => useReaderScroll(element));

    scrollTo(element, 5000);
    expect(result.current.progress).toBe(1);

    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 300 }); // max <= 0
    scrollTo(element, 10);
    expect(result.current.progress).toBe(0);
  });

  it("detaches from a removed scroll element and ignores its later scrolls", () => {
    const element = makeScroller(1000, 400);
    const { result, rerender } = renderHook(
      ({ el }: { el: HTMLElement | null }) => useReaderScroll(el),
      { initialProps: { el: element as HTMLElement | null } }
    );

    scrollTo(element, 300);
    expect(result.current.progress).toBeCloseTo(0.5);

    rerender({ el: null });
    // The listener is detached on teardown: a later scroll on the old element no longer updates
    // progress (it holds its last value), proving the effect cleanup removed the listener.
    scrollTo(element, 900);
    expect(result.current.progress).toBeCloseTo(0.5);
  });
});
