// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VoiceCaptureStatusDto } from "@whetstone/contracts";

import {
  isNonTerminalVoiceCapture,
  useVoiceCaptures,
  type VoiceCaptureApi
} from "./useVoiceCaptures";

function capture(overrides: Partial<VoiceCaptureStatusDto> = {}): VoiceCaptureStatusDto {
  return {
    failureReason: null,
    id: "cap-1",
    language: "en",
    occurredAt: "2026-07-09T10:00:00.000Z",
    status: "queued",
    text: null,
    ...overrides
  };
}

function makeApi(overrides: Partial<VoiceCaptureApi> = {}): VoiceCaptureApi {
  return {
    submit: vi.fn(async () => ({ id: "cap-new", status: "queued" as const })),
    fetchActive: vi.fn(async () => []),
    fetchStatus: vi.fn(async (id: string) => capture({ id })),
    retry: vi.fn(async (id: string) => capture({ id, status: "queued" })),
    ...overrides
  };
}

const POLL_MS = 1000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// Flush pending microtasks (awaited fetches) without advancing timers.
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Advance the poll timer once and let the poll's awaited fetches settle.
async function tick(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_MS);
  });
}

describe("isNonTerminalVoiceCapture", () => {
  it("treats queued/transcribing/tidying as non-terminal and ready/failed as terminal", () => {
    expect(isNonTerminalVoiceCapture(capture({ status: "queued" }))).toBe(true);
    expect(isNonTerminalVoiceCapture(capture({ status: "transcribing" }))).toBe(true);
    expect(isNonTerminalVoiceCapture(capture({ status: "tidying" }))).toBe(true);
    expect(isNonTerminalVoiceCapture(capture({ status: "ready" }))).toBe(false);
    expect(isNonTerminalVoiceCapture(capture({ status: "failed" }))).toBe(false);
  });
});

describe("useVoiceCaptures", () => {
  it("rebuilds the pending list from the server on mount, oldest first", async () => {
    const api = makeApi({
      fetchActive: vi.fn(async () => [
        capture({ id: "b", occurredAt: "2026-07-09T10:05:00.000Z", status: "transcribing" }),
        capture({ id: "a", occurredAt: "2026-07-09T10:00:00.000Z", status: "queued" })
      ])
    });
    const { result } = renderHook(() => useVoiceCaptures({ api, pollIntervalMs: POLL_MS }));

    await flush();

    expect(result.current.captures.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("leaves the list untouched when the initial refresh fails", async () => {
    const api = makeApi({
      fetchActive: vi.fn(async () => {
        throw new Error("offline");
      })
    });
    const { result } = renderHook(() => useVoiceCaptures({ api, pollIntervalMs: POLL_MS }));

    await flush();

    expect(result.current.captures).toEqual([]);
  });

  it("submits, refreshes from the server, and surfaces the new pending row", async () => {
    const fetchActive = vi
      .fn<VoiceCaptureApi["fetchActive"]>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([capture({ id: "cap-new", status: "queued" })]);
    const api = makeApi({ fetchActive });
    const { result } = renderHook(() => useVoiceCaptures({ api, pollIntervalMs: POLL_MS }));
    await flush();

    let ok = false;
    await act(async () => {
      ok = await result.current.submit(new Blob(["clip"]), "en");
    });

    expect(ok).toBe(true);
    expect(api.submit).toHaveBeenCalledWith(expect.any(Blob), "en");
    expect(result.current.captures.map((c) => c.id)).toEqual(["cap-new"]);
    expect(result.current.submitting).toBe(false);
  });

  it("returns false and keeps the list when a submit fails", async () => {
    const api = makeApi({
      submit: vi.fn(async () => {
        throw new Error("upload failed");
      })
    });
    const { result } = renderHook(() => useVoiceCaptures({ api, pollIntervalMs: POLL_MS }));
    await flush();

    let ok = true;
    await act(async () => {
      ok = await result.current.submit(new Blob(["clip"]), "en");
    });

    expect(ok).toBe(false);
    expect(result.current.captures).toEqual([]);
  });

  it("polls a non-terminal capture and updates its status in place", async () => {
    const api = makeApi({
      fetchActive: vi.fn(async () => [capture({ id: "cap-1", status: "transcribing" })]),
      fetchStatus: vi.fn(async () => capture({ id: "cap-1", status: "tidying" }))
    });
    const { result } = renderHook(() => useVoiceCaptures({ api, pollIntervalMs: POLL_MS }));
    await flush();

    await tick();

    expect(result.current.captures[0]?.status).toBe("tidying");
  });

  it("graduates a ready capture out of the list and notifies onReady", async () => {
    const ready = capture({ id: "cap-1", status: "ready", text: "the deploy is green" });
    const onReady = vi.fn();
    const api = makeApi({
      fetchActive: vi.fn(async () => [capture({ id: "cap-1", status: "tidying" })]),
      fetchStatus: vi.fn(async () => ready)
    });
    const { result } = renderHook(() =>
      useVoiceCaptures({ api, onReady, pollIntervalMs: POLL_MS })
    );
    await flush();

    await tick();

    expect(result.current.captures).toEqual([]);
    expect(onReady).toHaveBeenCalledWith(ready);
  });

  it("keeps a failed capture visible and stops polling it", async () => {
    const fetchStatus = vi.fn(async () => capture({ id: "cap-1", status: "failed" }));
    const api = makeApi({
      fetchActive: vi.fn(async () => [capture({ id: "cap-1", status: "transcribing" })]),
      fetchStatus
    });
    const { result } = renderHook(() => useVoiceCaptures({ api, pollIntervalMs: POLL_MS }));
    await flush();

    await tick();
    expect(result.current.captures[0]?.status).toBe("failed");

    const callsAfterFail = fetchStatus.mock.calls.length;
    await tick();
    await tick();
    expect(fetchStatus.mock.calls.length).toBe(callsAfterFail);
  });

  it("does not poll in a steady state with no pending work", async () => {
    const api = makeApi();
    renderHook(() => useVoiceCaptures({ api, pollIntervalMs: POLL_MS }));
    await flush();

    await tick();
    await tick();

    expect(api.fetchStatus).not.toHaveBeenCalled();
  });

  it("ignores an individual poll failure while advancing the others", async () => {
    const onReady = vi.fn();
    const fetchStatus = vi.fn(async (id: string) => {
      if (id === "bad") {
        throw new Error("flaky");
      }
      return capture({ id, status: "ready", text: "done" });
    });
    const api = makeApi({
      fetchActive: vi.fn(async () => [
        capture({ id: "bad", occurredAt: "2026-07-09T10:00:00.000Z", status: "transcribing" }),
        capture({ id: "good", occurredAt: "2026-07-09T10:01:00.000Z", status: "transcribing" })
      ]),
      fetchStatus
    });
    const { result } = renderHook(() =>
      useVoiceCaptures({ api, onReady, pollIntervalMs: POLL_MS })
    );
    await flush();

    await tick();

    expect(result.current.captures.map((c) => c.id)).toEqual(["bad"]);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("retries a failed capture in place and resumes polling until ready", async () => {
    const onReady = vi.fn();
    const fetchStatus = vi.fn(async (id: string) =>
      capture({ id, status: "ready", text: "recovered" })
    );
    const api = makeApi({
      fetchActive: vi.fn(async () => [capture({ id: "cap-1", status: "failed" })]),
      retry: vi.fn(async (id: string) => capture({ id, status: "queued" })),
      fetchStatus
    });
    const { result } = renderHook(() =>
      useVoiceCaptures({ api, onReady, pollIntervalMs: POLL_MS })
    );
    await flush();
    // Failed → not polled yet.
    await tick();
    expect(fetchStatus).not.toHaveBeenCalled();

    let ok = false;
    await act(async () => {
      ok = await result.current.retry("cap-1");
    });
    expect(ok).toBe(true);
    expect(result.current.captures[0]?.status).toBe("queued");

    await tick();
    expect(result.current.captures).toEqual([]);
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ id: "cap-1", status: "ready" }));
  });

  it("returns false when a retry fails", async () => {
    const api = makeApi({
      fetchActive: vi.fn(async () => [capture({ id: "cap-1", status: "failed" })]),
      retry: vi.fn(async () => {
        throw new Error("retry failed");
      })
    });
    const { result } = renderHook(() => useVoiceCaptures({ api, pollIntervalMs: POLL_MS }));
    await flush();

    let ok = true;
    await act(async () => {
      ok = await result.current.retry("cap-1");
    });

    expect(ok).toBe(false);
    expect(result.current.captures[0]?.status).toBe("failed");
  });

  it("leaves an unpolled failed row untouched while polling a sibling", async () => {
    const onReady = vi.fn();
    const api = makeApi({
      fetchActive: vi.fn(async () => [
        capture({ id: "failed-1", occurredAt: "2026-07-09T10:00:00.000Z", status: "failed" }),
        capture({ id: "live-1", occurredAt: "2026-07-09T10:01:00.000Z", status: "transcribing" })
      ]),
      fetchStatus: vi.fn(async () => capture({ id: "live-1", status: "ready", text: "done" }))
    });
    const { result } = renderHook(() =>
      useVoiceCaptures({ api, onReady, pollIntervalMs: POLL_MS })
    );
    await flush();

    await tick();

    expect(result.current.captures.map((c) => c.id)).toEqual(["failed-1"]);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("re-arms the poll each cycle until a capture becomes ready", async () => {
    // Two full poll cycles: the first leaves the capture non-terminal so the loop re-arms (firing the
    // scheduled `() => void tick()`), the second graduates it. Proves the self-scheduling keeps running.
    const fetchStatus = vi
      .fn<VoiceCaptureApi["fetchStatus"]>()
      .mockResolvedValueOnce(capture({ id: "cap-1", status: "tidying" }))
      .mockResolvedValue(capture({ id: "cap-1", status: "ready", text: "done" }));
    const onReady = vi.fn();
    const api = makeApi({
      fetchActive: vi.fn(async () => [capture({ id: "cap-1", status: "transcribing" })]),
      fetchStatus
    });
    const { result } = renderHook(() =>
      useVoiceCaptures({ api, onReady, pollIntervalMs: POLL_MS })
    );
    await flush();

    await tick();
    expect(result.current.captures[0]?.status).toBe("tidying");

    await tick();
    expect(result.current.captures).toEqual([]);
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ id: "cap-1", status: "ready" }));
  });

  it("does not re-arm the poll after the hook unmounts mid-request", async () => {
    // Tear down while a status request is in flight: when it resolves, the loop must see it was
    // cancelled and skip the re-arm rather than schedule another poll on a dead hook.
    let resolveStatus: (value: VoiceCaptureStatusDto) => void = () => undefined;
    const fetchStatus = vi.fn(
      () =>
        new Promise<VoiceCaptureStatusDto>((resolve) => {
          resolveStatus = resolve;
        })
    );
    const api = makeApi({
      fetchActive: vi.fn(async () => [capture({ id: "cap-1", status: "transcribing" })]),
      fetchStatus
    });
    const { unmount } = renderHook(() => useVoiceCaptures({ api, pollIntervalMs: POLL_MS }));
    await flush();

    // Fire the poll timer; the tick starts and blocks on the still-pending status request.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      resolveStatus(capture({ id: "cap-1", status: "tidying" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // No further poll was scheduled after teardown.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it("retries one capture without disturbing its siblings", async () => {
    const api = makeApi({
      fetchActive: vi.fn(async () => [
        capture({ id: "cap-1", occurredAt: "2026-07-09T10:00:00.000Z", status: "failed" }),
        capture({ id: "cap-2", occurredAt: "2026-07-09T10:01:00.000Z", status: "failed" })
      ]),
      retry: vi.fn(async (id: string) => capture({ id, status: "queued" }))
    });
    const { result } = renderHook(() => useVoiceCaptures({ api, pollIntervalMs: POLL_MS }));
    await flush();

    await act(async () => {
      await result.current.retry("cap-1");
    });

    expect(result.current.captures.find((c) => c.id === "cap-1")?.status).toBe("queued");
    expect(result.current.captures.find((c) => c.id === "cap-2")?.status).toBe("failed");
  });

  it("uses the default poll interval and real api bindings when none are injected", async () => {
    // Exercises the default-options path (defaultApi + DEFAULT_POLL_INTERVAL_MS) without a server: the
    // default fetchActive rejects under jsdom, so the list simply stays empty.
    const { result } = renderHook(() => useVoiceCaptures());
    await flush();
    expect(result.current.captures).toEqual([]);
  });
});
