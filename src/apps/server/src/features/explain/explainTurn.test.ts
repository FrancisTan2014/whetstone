import { describe, expect, it, vi } from "vitest";

import { AgentError } from "../../agent/agentFailure.js";
import type { Agent, AgentSession } from "../../agent/agentSession.js";
import { runExplainTurn, type ExplainTurnScheduler } from "./explainTurn.js";

function createManualScheduler(): {
  scheduler: ExplainTurnScheduler;
  fireTimeout: () => void;
  cancelCallCount: () => number;
} {
  let scheduledCallback: (() => void) | undefined;
  let cancelCalls = 0;
  const scheduler: ExplainTurnScheduler = {
    cancel: () => {
      cancelCalls += 1;
    },
    schedule: (callback) => {
      scheduledCallback = callback;
      return "handle";
    }
  };
  return {
    cancelCallCount: () => cancelCalls,
    fireTimeout: () => scheduledCallback?.(),
    scheduler
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe("runExplainTurn — successful path", () => {
  it("opens a session, sends the prompt, closes the session, and returns the turn", async () => {
    const { scheduler } = createManualScheduler();
    const close = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue({ text: "the answer" });
    const session: AgentSession = { close, send };
    const agent: Agent = { open: vi.fn().mockResolvedValue(session) };

    const outcome = await runExplainTurn({
      agent,
      prompt: "explain this",
      scheduler,
      sessionConfig: {},
      timeoutMs: 1000
    });

    expect(outcome).toEqual({ kind: "ok", turn: { text: "the answer" } });
    expect(send).toHaveBeenCalledWith("explain this");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("uses the real setTimeout-backed scheduler when none is supplied", async () => {
    // No `scheduler` override here — this exercises the module's own `defaultScheduler` (real
    // `setTimeout`/`clearTimeout`), unlike every other test in this file which injects a fake one.
    const close = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue({ text: "real scheduler answer" });
    const agent: Agent = { open: vi.fn().mockResolvedValue({ close, send }) };

    const outcome = await runExplainTurn({
      agent,
      prompt: "explain this",
      sessionConfig: {},
      timeoutMs: 1000
    });

    expect(outcome).toEqual({ kind: "ok", turn: { text: "real scheduler answer" } });
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("runExplainTurn — whole-request deadline", () => {
  it("reports timeout, and never sends a prompt, when open() resolves only after the deadline", async () => {
    const { scheduler, fireTimeout } = createManualScheduler();
    const openDeferred = deferred<AgentSession>();
    const send = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const agent: Agent = { open: vi.fn().mockReturnValue(openDeferred.promise) };

    const outcomePromise = runExplainTurn({
      agent,
      prompt: "explain this",
      scheduler,
      sessionConfig: {},
      timeoutMs: 1000
    });

    fireTimeout();
    await expect(outcomePromise).resolves.toEqual({ kind: "timeout" });
    expect(send).not.toHaveBeenCalled();

    // The session finally finishes opening AFTER the caller already moved on: it must be closed and
    // must never be handed the prompt.
    openDeferred.resolve({ close, send });
    await flushMicrotasks();
    expect(close).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows a late close() failure on a post-deadline session without throwing", async () => {
    const { scheduler, fireTimeout } = createManualScheduler();
    const openDeferred = deferred<AgentSession>();
    const agent: Agent = { open: vi.fn().mockReturnValue(openDeferred.promise) };

    const outcomePromise = runExplainTurn({
      agent,
      prompt: "explain this",
      scheduler,
      sessionConfig: {},
      timeoutMs: 1000
    });
    fireTimeout();
    await expect(outcomePromise).resolves.toEqual({ kind: "timeout" });

    openDeferred.resolve({
      close: vi.fn().mockRejectedValue(new Error("close failed")),
      send: vi.fn()
    });
    // No unhandled rejection / thrown error should escape this flush.
    await expect(flushMicrotasks()).resolves.toBeUndefined();
  });

  it("reports timeout and closes the session when send() resolves only after the deadline", async () => {
    const { scheduler, fireTimeout } = createManualScheduler();
    const sendDeferred = deferred<{ text: string }>();
    const close = vi.fn().mockResolvedValue(undefined);
    const session: AgentSession = { close, send: () => sendDeferred.promise };
    const agent: Agent = { open: vi.fn().mockResolvedValue(session) };

    const outcomePromise = runExplainTurn({
      agent,
      prompt: "explain this",
      scheduler,
      sessionConfig: {},
      timeoutMs: 1000
    });

    // Let the open-phase settle normally before the deadline fires, so it is the send-phase — not the
    // open-phase — that times out.
    await flushMicrotasks();
    fireTimeout();

    await expect(outcomePromise).resolves.toEqual({ kind: "timeout" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("swallows a close() failure after a send-phase timeout without throwing", async () => {
    const { scheduler, fireTimeout } = createManualScheduler();
    const sendDeferred = deferred<{ text: string }>();
    const close = vi.fn().mockRejectedValue(new Error("close failed during send timeout"));
    const session: AgentSession = { close, send: () => sendDeferred.promise };
    const agent: Agent = { open: vi.fn().mockResolvedValue(session) };

    const outcomePromise = runExplainTurn({
      agent,
      prompt: "explain this",
      scheduler,
      sessionConfig: {},
      timeoutMs: 1000
    });

    await flushMicrotasks();
    fireTimeout();

    await expect(outcomePromise).resolves.toEqual({ kind: "timeout" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reuses one shared deadline across the whole request rather than a fresh timer per phase", async () => {
    const scheduleCalls: number[] = [];
    let scheduledCallback: (() => void) | undefined;
    const scheduler: ExplainTurnScheduler = {
      cancel: () => {},
      schedule: (callback, ms) => {
        scheduleCalls.push(ms);
        scheduledCallback = callback;
        return "handle";
      }
    };
    const close = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue({ text: "ok" });
    const agent: Agent = { open: vi.fn().mockResolvedValue({ close, send }) };

    await runExplainTurn({ agent, prompt: "p", scheduler, sessionConfig: {}, timeoutMs: 1000 });

    expect(scheduleCalls).toEqual([1000]);
    expect(scheduledCallback).toBeDefined();
  });
});

describe("runExplainTurn — open() failure", () => {
  it("maps an agent_startup_failed AgentError to startup_failed", async () => {
    const { scheduler } = createManualScheduler();
    const agent: Agent = {
      open: vi.fn().mockRejectedValue(new AgentError("agent_startup_failed", "no auth"))
    };

    const outcome = await runExplainTurn({
      agent,
      prompt: "p",
      scheduler,
      sessionConfig: {},
      timeoutMs: 1000
    });

    expect(outcome).toEqual({ code: "startup_failed", kind: "failed" });
  });

  it("maps an agent_unsupported_model AgentError to unsupported_model", async () => {
    const { scheduler } = createManualScheduler();
    const agent: Agent = {
      open: vi.fn().mockRejectedValue(new AgentError("agent_unsupported_model", "bad model"))
    };

    const outcome = await runExplainTurn({
      agent,
      prompt: "p",
      scheduler,
      sessionConfig: {},
      timeoutMs: 1000
    });

    expect(outcome).toEqual({ code: "unsupported_model", kind: "failed" });
  });

  it("maps any other agent failure code (e.g. agent_transport_failed) to transport_failed", async () => {
    const { scheduler } = createManualScheduler();
    const agent: Agent = {
      open: vi.fn().mockRejectedValue(new AgentError("agent_transport_failed", "rpc failed"))
    };

    const outcome = await runExplainTurn({
      agent,
      prompt: "p",
      scheduler,
      sessionConfig: {},
      timeoutMs: 1000
    });

    expect(outcome).toEqual({ code: "transport_failed", kind: "failed" });
  });

  it("maps a non-AgentError thrown value to transport_failed", async () => {
    const { scheduler } = createManualScheduler();
    const agent: Agent = { open: vi.fn().mockRejectedValue(new Error("unexpected")) };

    const outcome = await runExplainTurn({
      agent,
      prompt: "p",
      scheduler,
      sessionConfig: {},
      timeoutMs: 1000
    });

    expect(outcome).toEqual({ code: "transport_failed", kind: "failed" });
  });

  it("clears the deadline timer once open() has failed", async () => {
    const { scheduler, cancelCallCount } = createManualScheduler();
    const agent: Agent = { open: vi.fn().mockRejectedValue(new Error("unexpected")) };

    await runExplainTurn({ agent, prompt: "p", scheduler, sessionConfig: {}, timeoutMs: 1000 });

    expect(cancelCallCount()).toBe(1);
  });
});

describe("runExplainTurn — send() failure", () => {
  it("maps a send() AgentError and still closes the session", async () => {
    const { scheduler } = createManualScheduler();
    const close = vi.fn().mockResolvedValue(undefined);
    const session: AgentSession = {
      close,
      send: vi.fn().mockRejectedValue(new AgentError("agent_transport_failed", "rpc failed"))
    };
    const agent: Agent = { open: vi.fn().mockResolvedValue(session) };

    const outcome = await runExplainTurn({
      agent,
      prompt: "p",
      scheduler,
      sessionConfig: {},
      timeoutMs: 1000
    });

    expect(outcome).toEqual({ code: "transport_failed", kind: "failed" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the session even when close() itself fails after a send() failure", async () => {
    const { scheduler } = createManualScheduler();
    const session: AgentSession = {
      close: vi.fn().mockRejectedValue(new Error("close failed too")),
      send: vi.fn().mockRejectedValue(new Error("send failed"))
    };
    const agent: Agent = { open: vi.fn().mockResolvedValue(session) };

    const outcome = await runExplainTurn({
      agent,
      prompt: "p",
      scheduler,
      sessionConfig: {},
      timeoutMs: 1000
    });

    expect(outcome).toEqual({ code: "transport_failed", kind: "failed" });
  });
});
