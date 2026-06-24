// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PositionStore } from "./readingPosition";
import { positionWriteDelayMs, useReadingPositionWriter } from "./useReadingPositionWriter";

function fakeStore(): { store: PositionStore; write: ReturnType<typeof vi.fn> } {
  const write = vi.fn();
  return { store: { read: vi.fn(() => undefined), write }, write };
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useReadingPositionWriter", () => {
  it("writes nothing when there is no active reading target", () => {
    const { store, write } = fakeStore();
    renderHook(() => useReadingPositionWriter(store, undefined));

    expect(write).not.toHaveBeenCalled();
  });

  it("records the position immediately when a unit becomes active", () => {
    const { store, write } = fakeStore();
    Object.defineProperty(window, "scrollY", { configurable: true, value: 240 });

    renderHook(() =>
      useReadingPositionWriter(store, { unitEntryId: "u-2", workEntryId: "work-1" })
    );

    expect(write).toHaveBeenCalledWith("work-1", { scrollOffset: 240, unitEntryId: "u-2" });
  });

  it("debounces writes while scrolling", () => {
    const { store, write } = fakeStore();
    renderHook(() =>
      useReadingPositionWriter(store, { unitEntryId: "u-1", workEntryId: "work-1" })
    );
    write.mockClear();

    Object.defineProperty(window, "scrollY", { configurable: true, value: 100 });
    window.dispatchEvent(new Event("scroll"));
    Object.defineProperty(window, "scrollY", { configurable: true, value: 300 });
    window.dispatchEvent(new Event("scroll"));

    // Both scrolls collapse into a single trailing write.
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(positionWriteDelayMs);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("work-1", { scrollOffset: 300, unitEntryId: "u-1" });
  });

  it("stops writing after unmount", () => {
    const { store, write } = fakeStore();
    const { unmount } = renderHook(() =>
      useReadingPositionWriter(store, { unitEntryId: "u-1", workEntryId: "work-1" })
    );
    write.mockClear();

    unmount();
    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(positionWriteDelayMs);

    expect(write).not.toHaveBeenCalled();
  });
});
