// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useMediaQuery } from "./useMediaQuery";

type Listener = () => void;

function installMatchMedia(initialMatches: boolean): { setMatches: (next: boolean) => void } {
  let matches = initialMatches;
  const listeners = new Set<Listener>();
  const mediaQueryList = {
    addEventListener: (_event: string, listener: Listener) => listeners.add(listener),
    get matches() {
      return matches;
    },
    media: "",
    removeEventListener: (_event: string, listener: Listener) => listeners.delete(listener)
  };

  window.matchMedia = vi
    .fn()
    .mockReturnValue(mediaQueryList) as unknown as typeof window.matchMedia;

  return {
    setMatches: (next: boolean) => {
      matches = next;
      listeners.forEach((listener) => listener());
    }
  };
}

afterEach(() => {
  cleanup();
});

describe("useMediaQuery", () => {
  it("returns the initial match, reacts to changes, and unsubscribes on unmount", () => {
    const control = installMatchMedia(false);

    const { result, unmount } = renderHook(() => useMediaQuery("(min-width: 768px)"));
    expect(result.current).toBe(false);

    act(() => {
      control.setMatches(true);
    });
    expect(result.current).toBe(true);

    unmount();
    // After unmount the listener is removed, so further changes are ignored.
    act(() => {
      control.setMatches(false);
    });
    expect(result.current).toBe(true);
  });
});
