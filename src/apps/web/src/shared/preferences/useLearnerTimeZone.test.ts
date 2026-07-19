// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./preferencesApi", () => ({
  loadPersistedTimeZone: vi.fn(),
  resolveBrowserTimeZone: vi.fn()
}));

import { loadPersistedTimeZone, resolveBrowserTimeZone } from "./preferencesApi";
import { useLearnerTimeZone } from "./useLearnerTimeZone";

const mockedBrowser = vi.mocked(resolveBrowserTimeZone);
const mockedLoad = vi.mocked(loadPersistedTimeZone);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useLearnerTimeZone (#676)", () => {
  it("starts from the browser zone, then adopts the persisted zone once it loads", async () => {
    mockedBrowser.mockReturnValue("UTC");
    mockedLoad.mockResolvedValue("America/New_York");

    const { result } = renderHook(() => useLearnerTimeZone());

    // First render is sensible immediately, before the server-owned preference resolves.
    expect(result.current).toBe("UTC");
    await waitFor(() => expect(result.current).toBe("America/New_York"));
  });

  it("keeps the browser-zone fallback when the persisted zone fails to load", async () => {
    mockedBrowser.mockReturnValue("Asia/Kolkata");
    mockedLoad.mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => useLearnerTimeZone());
    expect(result.current).toBe("Asia/Kolkata");

    // The rejection is swallowed by the hook's onRejected handler; the fallback must survive it.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe("Asia/Kolkata");
  });

  it("drops a resolve that lands after unmount so no state update races teardown", async () => {
    mockedBrowser.mockReturnValue("UTC");
    let resolveZone: (zone: string) => void = () => {};
    mockedLoad.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveZone = resolve;
      })
    );

    const { result, unmount } = renderHook(() => useLearnerTimeZone());
    expect(result.current).toBe("UTC");

    unmount();
    // The active flag must drop this late resolve: no throw, no act warning, no set after unmount.
    await act(async () => {
      resolveZone("America/New_York");
      await Promise.resolve();
    });
  });
});
