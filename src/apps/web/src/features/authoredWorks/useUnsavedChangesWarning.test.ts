// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useUnsavedChangesWarning } from "./useUnsavedChangesWarning";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useUnsavedChangesWarning", () => {
  it("warns on beforeunload while there are unsaved changes", () => {
    renderHook(() => useUnsavedChangesWarning(true));

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("removes the warning when it becomes inactive", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { rerender } = renderHook(({ active }) => useUnsavedChangesWarning(active), {
      initialProps: { active: true }
    });

    rerender({ active: false });
    expect(removeSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function));

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("adds no warning when inactive from the start", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    renderHook(() => useUnsavedChangesWarning(false));

    expect(addSpy).not.toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });
});
