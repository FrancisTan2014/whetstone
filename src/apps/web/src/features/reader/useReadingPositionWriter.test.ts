// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { positionWriteDelayMs, useReadingPositionWriter } from "./useReadingPositionWriter";

// Lay out a block in the reading order with a controllable viewport-relative rect so the writer's
// topmost-visible-block capture is deterministic.
function addBlock(id: string, bottom: number): void {
  const element = document.createElement("p");
  element.setAttribute("data-block-id", id);
  element.getBoundingClientRect = () => ({ bottom }) as DOMRect;
  document.body.appendChild(element);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("useReadingPositionWriter", () => {
  it("writes nothing when there is no active reading target", () => {
    const save = vi.fn();
    renderHook(() => useReadingPositionWriter(save, undefined));

    expect(save).not.toHaveBeenCalled();
  });

  it("records the unit and topmost visible block immediately when a unit becomes active", () => {
    const save = vi.fn();
    addBlock("b-1", -10);
    addBlock("b-2", 50);

    renderHook(() => useReadingPositionWriter(save, { unitEntryId: "u-2", workEntryId: "work-1" }));

    expect(save).toHaveBeenCalledWith("work-1", { anchorBlockEntryId: "b-2", unitEntryId: "u-2" });
  });

  it("records just the unit when no block is visible", () => {
    const save = vi.fn();

    renderHook(() => useReadingPositionWriter(save, { unitEntryId: "u-1", workEntryId: "work-1" }));

    expect(save).toHaveBeenCalledWith("work-1", { unitEntryId: "u-1" });
  });

  it("debounces scroll writes and captures the topmost visible block", () => {
    const save = vi.fn();
    addBlock("b-1", 40);

    renderHook(() => useReadingPositionWriter(save, { unitEntryId: "u-1", workEntryId: "work-1" }));
    save.mockClear();

    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("scroll"));

    // Both scrolls collapse into a single trailing write.
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(positionWriteDelayMs);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("work-1", { anchorBlockEntryId: "b-1", unitEntryId: "u-1" });
  });

  it("stops writing after unmount", () => {
    const save = vi.fn();
    const { unmount } = renderHook(() =>
      useReadingPositionWriter(save, { unitEntryId: "u-1", workEntryId: "work-1" })
    );
    save.mockClear();

    unmount();
    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(positionWriteDelayMs);

    expect(save).not.toHaveBeenCalled();
  });
});
