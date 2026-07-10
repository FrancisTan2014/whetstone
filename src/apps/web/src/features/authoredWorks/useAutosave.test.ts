// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { createTextDocument, type DocumentNodeJSON } from "@whetstone/document";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { autosaveDelayMs, useAutosave, type SaveDocument } from "./useAutosave";

type Deferred = Readonly<{
  promise: Promise<void>;
  reject: (error: Error) => void;
  resolve: () => void;
}>;

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

// A save whose every call hands back a controllable deferred, so a test drives when each persist settles.
function controllableSave(): Readonly<{ pending: Deferred[]; save: SaveDocument }> {
  const pending: Deferred[] = [];
  const save: SaveDocument = vi.fn(() => {
    const next = deferred();
    pending.push(next);
    return next.promise;
  });
  return { pending, save };
}

const docA = createTextDocument("A");
const docB = createTextDocument("B");

function bodyOf(mock: SaveDocument, call: number): DocumentNodeJSON {
  return (mock as unknown as { mock: { calls: DocumentNodeJSON[][] } }).mock.calls[call]![0]!;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useAutosave", () => {
  it("waits for the debounce, then reports saving and finally saved", async () => {
    const { pending, save } = controllableSave();
    const { result } = renderHook(() => useAutosave(save));

    act(() => result.current.notifyChange(docA));
    expect(result.current.status).toBe("unsaved");
    expect(result.current.hasUnsavedChanges).toBe(true);

    act(() => vi.advanceTimersByTime(autosaveDelayMs - 1));
    expect(save).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("saving");

    await act(async () => {
      pending[0]!.resolve();
    });
    expect(result.current.status).toBe("saved");
    expect(result.current.hasUnsavedChanges).toBe(false);
  });

  it("coalesces rapid edits into a single save of the latest document", () => {
    const { save } = controllableSave();
    const { result } = renderHook(() => useAutosave(save));

    act(() => result.current.notifyChange(docA));
    act(() => result.current.notifyChange(docB));
    act(() => vi.advanceTimersByTime(autosaveDelayMs));

    expect(save).toHaveBeenCalledTimes(1);
    expect(bodyOf(save, 0)).toEqual(docB);
  });

  it("is latest-write-safe: an edit during an in-flight save triggers a follow-up save", async () => {
    const { pending, save } = controllableSave();
    const { result } = renderHook(() => useAutosave(save));

    act(() => result.current.notifyChange(docA));
    act(() => vi.advanceTimersByTime(autosaveDelayMs));
    expect(save).toHaveBeenCalledTimes(1);

    // A newer edit lands while the first save is still in flight — the indicator stays "saving".
    act(() => result.current.notifyChange(docB));
    expect(result.current.status).toBe("saving");

    await act(async () => {
      pending[0]!.resolve();
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(bodyOf(save, 1)).toEqual(docB);
    expect(result.current.status).toBe("saving");

    await act(async () => {
      pending[1]!.resolve();
    });
    expect(result.current.status).toBe("saved");
    expect(result.current.hasUnsavedChanges).toBe(false);
  });

  it("reports error on a failed save and retries on the next edit", async () => {
    const { pending, save } = controllableSave();
    const { result } = renderHook(() => useAutosave(save));

    act(() => result.current.notifyChange(docA));
    act(() => vi.advanceTimersByTime(autosaveDelayMs));
    await act(async () => {
      pending[0]!.reject(new Error("boom"));
    });
    expect(result.current.status).toBe("error");
    expect(result.current.hasUnsavedChanges).toBe(true);

    // A later edit retries the failed document.
    act(() => result.current.notifyChange(docB));
    act(() => vi.advanceTimersByTime(autosaveDelayMs));
    expect(save).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending[1]!.resolve();
    });
    expect(result.current.status).toBe("saved");
  });

  it("keeps a newer pending edit over the document whose save failed", async () => {
    const { pending, save } = controllableSave();
    const { result } = renderHook(() => useAutosave(save));

    act(() => result.current.notifyChange(docA));
    act(() => vi.advanceTimersByTime(autosaveDelayMs));
    act(() => result.current.notifyChange(docB));

    await act(async () => {
      pending[0]!.reject(new Error("boom"));
    });
    act(() => vi.advanceTimersByTime(autosaveDelayMs));

    expect(save).toHaveBeenCalledTimes(2);
    expect(bodyOf(save, 1)).toEqual(docB);
  });

  it("saveNow flushes the debounce and saves immediately", () => {
    const { save } = controllableSave();
    const { result } = renderHook(() => useAutosave(save));

    act(() => result.current.notifyChange(docA));
    act(() => result.current.saveNow());

    expect(save).toHaveBeenCalledTimes(1);
  });

  it("saveNow with nothing pending is a no-op", () => {
    const { save } = controllableSave();
    const { result } = renderHook(() => useAutosave(save));

    act(() => result.current.saveNow());

    expect(save).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });

  it("saveNow while a save is in flight does not start a second save", async () => {
    const { pending, save } = controllableSave();
    const { result } = renderHook(() => useAutosave(save));

    act(() => result.current.notifyChange(docA));
    act(() => vi.advanceTimersByTime(autosaveDelayMs));
    act(() => result.current.saveNow());

    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending[0]!.resolve();
    });
    expect(result.current.status).toBe("saved");
  });

  it("does not update state after unmount", async () => {
    const { pending, save } = controllableSave();
    const { result, unmount } = renderHook(() => useAutosave(save));

    act(() => result.current.notifyChange(docA));
    act(() => vi.advanceTimersByTime(autosaveDelayMs));
    const controller = result.current;
    unmount();

    await act(async () => {
      pending[0]!.resolve();
    });
    // A change after unmount must not throw despite the guarded setState paths.
    expect(() => controller.notifyChange(docB)).not.toThrow();
  });
});
