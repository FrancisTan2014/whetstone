import { describe, expect, it, vi } from "vitest";

import { isAgentError } from "./agentFailure.js";
import type { AgentSessionConfig } from "./agentSession.js";
import type { CopilotSdkConfig } from "./copilotSdkConfig.js";
import {
  buildCopilotClientOptions,
  buildCopilotSessionConfig,
  type CopilotIdleScheduler,
  type CopilotRuntimeClient,
  type CopilotRuntimeSession,
  createCopilotSdkAgentRuntime,
  denyAllCopilotPermissions
} from "./copilotSdkAgent.js";

const fakeConfig: CopilotSdkConfig = {
  copilotHome: "C:\\fake\\copilot-home",
  model: "gpt-5.4",
  reasoningEffort: "high"
};

// ------------------------------------------------------------------------------------------------
// Pure builder / prompt-only enforcement coverage: no client, no runtime, no timers involved.
// ------------------------------------------------------------------------------------------------

describe("buildCopilotClientOptions", () => {
  it("uses the seam's own scratch directory and the safe multi-user-server mode", () => {
    expect(buildCopilotClientOptions(fakeConfig)).toEqual({
      baseDirectory: fakeConfig.copilotHome,
      clientInfo: { applicationName: "whetstone" },
      mode: "empty"
    });
  });
});

describe("denyAllCopilotPermissions", () => {
  it("rejects every permission request, by construction", () => {
    expect(denyAllCopilotPermissions({} as never, {} as never)).toEqual({
      feedback: expect.stringContaining("prompt-only"),
      kind: "reject"
    });
  });
});

describe("buildCopilotSessionConfig", () => {
  it("closes every tool surface and every ambient-behavior default", () => {
    const sessionConfig = buildCopilotSessionConfig(fakeConfig, {});

    expect(sessionConfig).toMatchObject({
      availableTools: [],
      customAgentsLocalOnly: true,
      manageScheduleEnabled: false,
      model: fakeConfig.model,
      onPermissionRequest: denyAllCopilotPermissions,
      reasoningEffort: fakeConfig.reasoningEffort,
      skipCustomInstructions: true
    });
    expect(sessionConfig).not.toHaveProperty("systemMessage");
  });

  it("carries instructions as the session's persistent system message when present", () => {
    const sessionConfig = buildCopilotSessionConfig(fakeConfig, { instructions: "Be terse." });

    expect(sessionConfig.systemMessage).toEqual({ content: "Be terse." });
  });

  it("treats blank instructions the same as absent instructions", () => {
    const sessionConfig = buildCopilotSessionConfig(fakeConfig, { instructions: "   " });

    expect(sessionConfig).not.toHaveProperty("systemMessage");
  });
});

// ------------------------------------------------------------------------------------------------
// Lifecycle coverage: a fully scripted fake `CopilotRuntimeClient` drives every path with no SDK, no
// process, and no real timers involved.
// ------------------------------------------------------------------------------------------------

function createFakeSession(
  overrides: Partial<CopilotRuntimeSession> = {}
): CopilotRuntimeSession & {
  sendAndWaitMock: ReturnType<typeof vi.fn>;
  disconnectMock: ReturnType<typeof vi.fn>;
} {
  const sendAndWaitMock = vi.fn(
    overrides.sendAndWait ?? (async () => ({ content: "reply", kind: "ok" as const }))
  );
  const disconnectMock = vi.fn(overrides.disconnect ?? (async () => {}));
  return {
    disconnectMock,
    sendAndWait: sendAndWaitMock,
    disconnect: disconnectMock,
    sendAndWaitMock
  };
}

function createFakeClient(
  overrides: {
    start?: CopilotRuntimeClient["start"];
    listModels?: CopilotRuntimeClient["listModels"];
    createSession?: CopilotRuntimeClient["createSession"];
  } = {}
) {
  const startMock = vi.fn(overrides.start ?? (async () => {}));
  const listModelsMock = vi.fn(
    overrides.listModels ??
      (async () => [
        { id: fakeConfig.model, supportedReasoningEfforts: [fakeConfig.reasoningEffort] }
      ])
  );
  const stopMock = vi.fn(async () => {});
  const sessions: ReturnType<typeof createFakeSession>[] = [];
  const createSessionMock = vi.fn(
    overrides.createSession ??
      (async (_sessionConfig: AgentSessionConfig) => {
        const session = createFakeSession();
        sessions.push(session);
        return session;
      })
  );

  const client: CopilotRuntimeClient = {
    createSession: createSessionMock,
    listModels: listModelsMock,
    start: startMock,
    stop: stopMock
  };

  return { client, createSessionMock, listModelsMock, sessions, startMock, stopMock };
}

function createFakeScheduler() {
  const scheduled: Array<{ callback: () => void; ms: number }> = [];
  let cancelCount = 0;

  const scheduler: CopilotIdleScheduler = {
    cancel: () => {
      cancelCount += 1;
    },
    schedule: (callback, ms) => {
      const entry = { callback, ms };
      scheduled.push(entry);
      return entry;
    }
  };

  return {
    get cancelCount() {
      return cancelCount;
    },
    fireLatest: () => scheduled.at(-1)?.callback(),
    scheduled,
    scheduler
  };
}

describe("createCopilotSdkAgentRuntime", () => {
  it("starts nothing until the first open() call (lazy startup)", () => {
    const factory = vi.fn(() => createFakeClient().client);

    createCopilotSdkAgentRuntime({ config: fakeConfig, createRuntimeClient: factory });

    expect(factory).not.toHaveBeenCalled();
  });

  it("reuses one warm runtime across independent open() calls, each with its own fresh session", async () => {
    const fake = createFakeClient();
    const factory = vi.fn(() => fake.client);
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: factory
    });

    const session1 = await runtime.agent.open({});
    const session2 = await runtime.agent.open({});

    expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.startMock).toHaveBeenCalledTimes(1);
    expect(fake.createSessionMock).toHaveBeenCalledTimes(2);
    expect(session1).not.toBe(session2);
  });

  it("forwards the configured model and a supported reasoning effort, validated against listModels", async () => {
    const fake = createFakeClient({
      listModels: async () => [{ id: fakeConfig.model, supportedReasoningEfforts: ["high", "max"] }]
    });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });

    await expect(runtime.agent.open({})).resolves.toBeDefined();
  });

  it("shares one in-flight start across concurrent open() calls (concurrency-safe startup)", async () => {
    let resolveStart: () => void = () => {};
    const startPromise = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const fake = createFakeClient({ start: () => startPromise });
    const factory = vi.fn(() => fake.client);
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: factory
    });

    const p1 = runtime.agent.open({});
    const p2 = runtime.agent.open({});
    expect(factory).toHaveBeenCalledTimes(1);

    resolveStart();
    const [session1, session2] = await Promise.all([p1, p2]);

    expect(session1).not.toBe(session2);
    expect(fake.startMock).toHaveBeenCalledTimes(1);
  });

  it("denies every tool by sending an explicitly empty availableTools list", async () => {
    const fake = createFakeClient();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });

    await runtime.agent.open({ instructions: "Explain a word family." });

    expect(fake.createSessionMock).toHaveBeenCalledWith({ instructions: "Explain a word family." });
  });

  it("fails by name, and cleans up, when the connected runtime does not report the configured model", async () => {
    const fake = createFakeClient({ listModels: async () => [{ id: "some-other-model" }] });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });

    const error: unknown = await runtime.agent.open({}).catch((caught: unknown) => caught);

    expect(isAgentError(error) ? error.code : undefined).toBe("agent_unsupported_model");
    expect(fake.stopMock).toHaveBeenCalledTimes(1);
  });

  it("fails by name when the model does not support the configured reasoning effort", async () => {
    const fake = createFakeClient({
      listModels: async () => [{ id: fakeConfig.model, supportedReasoningEfforts: ["low"] }]
    });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });

    const error: unknown = await runtime.agent.open({}).catch((caught: unknown) => caught);

    expect(isAgentError(error) ? error.code : undefined).toBe("agent_unsupported_model");
  });

  it("names 'none reported' when the connected runtime advertises no models at all", async () => {
    const fake = createFakeClient({ listModels: async () => [] });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });

    const error: unknown = await runtime.agent.open({}).catch((caught: unknown) => caught);

    expect(isAgentError(error) && error.message).toContain("none reported");
  });

  it("names 'none' supported when the model reports no reasoning efforts at all", async () => {
    const fake = createFakeClient({ listModels: async () => [{ id: fakeConfig.model }] });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });

    const error: unknown = await runtime.agent.open({}).catch((caught: unknown) => caught);

    expect(isAgentError(error) && error.message).toContain("(supported: none)");
  });

  it("does not gate on a generic auto-routing placeholder catalog (verified live account behavior, #923)", async () => {
    // Some Copilot accounts/plans report only `[{ id: "auto" }]` from listModels(), with no
    // per-model capability data at all, yet still honor an explicit configured model at the
    // transport level. Rejecting this issue's own default (gpt-5.4) for every account in that state
    // would be worse than the narrow validation gap this case accepts.
    const fake = createFakeClient({ listModels: async () => [{ id: "auto" }] });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });

    await expect(runtime.agent.open({})).resolves.toBeDefined();
  });

  it("classifies a non-Error rejection using its string representation", async () => {
    const fake = createFakeClient({ createSession: () => Promise.reject("boom") });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });

    const error: unknown = await runtime.agent.open({}).catch((caught: unknown) => caught);

    expect(isAgentError(error) && error.message).toContain("boom");
  });

  it("resets to cold after a failed start, so the very next open() gets a fresh attempt", async () => {
    const failing = createFakeClient({ start: () => Promise.reject(new Error("no auth")) });
    const ok = createFakeClient();
    const factory = vi.fn().mockReturnValueOnce(failing.client).mockReturnValueOnce(ok.client);
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: factory
    });

    const firstError: unknown = await runtime.agent.open({}).catch((caught: unknown) => caught);
    expect(isAgentError(firstError) ? firstError.code : undefined).toBe("agent_startup_failed");
    expect(failing.stopMock).toHaveBeenCalledTimes(1);

    await expect(runtime.agent.open({})).resolves.toBeDefined();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("swallows a cleanup stop() failure after a failed start without masking the real error", async () => {
    const failing = createFakeClient({ start: () => Promise.reject(new Error("no auth")) });
    failing.stopMock.mockRejectedValueOnce(new Error("stop also failed"));
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => failing.client
    });

    const error: unknown = await runtime.agent.open({}).catch((caught: unknown) => caught);

    expect(isAgentError(error) ? error.code : undefined).toBe("agent_startup_failed");
    expect(isAgentError(error) ? error.message : undefined).toContain("no auth");
  });

  it("does not automatically retry a failed start on behalf of concurrent waiters", async () => {
    const failing = createFakeClient({ start: () => Promise.reject(new Error("no auth")) });
    const factory = vi.fn(() => failing.client);
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: factory
    });

    const [e1, e2] = await Promise.all([
      runtime.agent.open({}).catch((caught: unknown) => caught),
      runtime.agent.open({}).catch((caught: unknown) => caught)
    ]);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(isAgentError(e1) ? e1.code : undefined).toBe("agent_startup_failed");
    expect(isAgentError(e2) ? e2.code : undefined).toBe("agent_startup_failed");
  });

  it("classifies a timed-out turn as agent_timeout without touching the session", async () => {
    const fake = createFakeClient({
      createSession: async () =>
        createFakeSession({ sendAndWait: async () => ({ kind: "timeout" }) })
    });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });
    const session = await runtime.agent.open({});

    const error: unknown = await session.send("hi").catch((caught: unknown) => caught);

    expect(isAgentError(error) ? error.code : undefined).toBe("agent_timeout");
  });

  it("classifies a runtime-reported turn failure as agent_transport_failed", async () => {
    const fake = createFakeClient({
      createSession: async () =>
        createFakeSession({
          sendAndWait: async () => ({ kind: "failed", message: "connection reset" })
        })
    });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });
    const session = await runtime.agent.open({});

    const error: unknown = await session.send("hi").catch((caught: unknown) => caught);

    expect(isAgentError(error) ? error.code : undefined).toBe("agent_transport_failed");
    expect(isAgentError(error) ? error.message : undefined).toContain("connection reset");
  });

  it("returns the provider's text on a successful turn", async () => {
    const fake = createFakeClient({
      createSession: async () =>
        createFakeSession({
          sendAndWait: async () => ({ content: "a family of senses", kind: "ok" })
        })
    });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });
    const session = await runtime.agent.open({});

    await expect(session.send("hi")).resolves.toEqual({ text: "a family of senses" });
  });

  it("classifies a session that fails to open as agent_transport_failed", async () => {
    const fake = createFakeClient({ createSession: () => Promise.reject(new Error("rpc error")) });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });

    const error: unknown = await runtime.agent.open({}).catch((caught: unknown) => caught);

    expect(isAgentError(error) ? error.code : undefined).toBe("agent_transport_failed");
  });

  it("rejects a send() after close() by name, never starting a second conversation silently", async () => {
    const fake = createFakeClient();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });
    const session = await runtime.agent.open({});
    await session.close();

    const error: unknown = await session.send("hi").catch((caught: unknown) => caught);

    expect(isAgentError(error) ? error.code : undefined).toBe("agent_session_closed");
  });

  it("is safe to close a session even when disconnect() itself rejects", async () => {
    const fake = createFakeClient({
      createSession: async () =>
        createFakeSession({ disconnect: () => Promise.reject(new Error("gone")) })
    });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });
    const session = await runtime.agent.open({});

    await expect(session.close()).resolves.toBeUndefined();
  });

  it("is safe to close a session twice", async () => {
    const fake = createFakeClient();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });
    const session = await runtime.agent.open({});

    await session.close();
    await expect(session.close()).resolves.toBeUndefined();
    expect(fake.sessions[0]?.disconnectMock).toHaveBeenCalledTimes(1);
  });

  it("schedules idle disposal only once the last open session closes, and disposes then", async () => {
    const fake = createFakeClient();
    const idle = createFakeScheduler();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client,
      idleScheduler: idle.scheduler,
      idleTimeoutMs: 5000
    });

    const session1 = await runtime.agent.open({});
    const session2 = await runtime.agent.open({});
    expect(idle.scheduled).toHaveLength(0);

    await session1.close();
    expect(idle.scheduled).toHaveLength(0); // session2 still open: never reaps active work

    await session2.close();
    expect(idle.scheduled).toHaveLength(1);
    expect(idle.scheduled[0]?.ms).toBe(5000);

    idle.fireLatest();
    await vi.waitFor(() => expect(fake.stopMock).toHaveBeenCalledTimes(1));
  });

  it("cancels a pending idle timer as soon as a new session opens", async () => {
    const fake = createFakeClient();
    const idle = createFakeScheduler();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client,
      idleScheduler: idle.scheduler
    });

    const session1 = await runtime.agent.open({});
    await session1.close();
    expect(idle.scheduled).toHaveLength(1);

    await runtime.agent.open({});
    expect(idle.cancelCount).toBe(1);
  });

  it("never disposes on a stale idle callback that fires after a session reopened (race safety)", async () => {
    const fake = createFakeClient();
    const idle = createFakeScheduler();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client,
      idleScheduler: idle.scheduler
    });

    const session1 = await runtime.agent.open({});
    await session1.close();
    const staleCallback = idle.scheduled[0]?.callback;
    expect(staleCallback).toBeDefined();

    await runtime.agent.open({}); // reopens before the (fake, uncancellable-in-this-test) timer fires
    staleCallback?.();

    expect(fake.stopMock).not.toHaveBeenCalled();
  });

  it("logs a failed status when the idle-triggered stop() itself rejects", async () => {
    const fake = createFakeClient();
    fake.stopMock.mockRejectedValueOnce(new Error("stop failed"));
    const idle = createFakeScheduler();
    const log = vi.fn();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client,
      idleScheduler: idle.scheduler,
      log
    });
    const session = await runtime.agent.open({});
    await session.close();

    idle.fireLatest();
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ event: "runtime_idle_dispose", status: "agent_transport_failed" })
      )
    );
  });

  it("uses real timers by default to schedule and cancel idle disposal", async () => {
    const fake = createFakeClient();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client,
      idleTimeoutMs: 10
    });

    const session = await runtime.agent.open({});
    await session.close();
    await vi.waitFor(() => expect(fake.stopMock).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it("cancels the real default idle timer when a new session opens before it fires", async () => {
    const fake = createFakeClient();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client,
      idleTimeoutMs: 50
    });

    const session1 = await runtime.agent.open({});
    await session1.close();
    await runtime.agent.open({});

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.stopMock).not.toHaveBeenCalled();
  });

  it("does not stop a runtime whose in-flight start ultimately failed while disposing", async () => {
    let rejectStart: (error: Error) => void = () => {};
    const startPromise = new Promise<void>((_resolve, reject) => {
      rejectStart = reject;
    });
    const fake = createFakeClient({ start: () => startPromise });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });

    const openPromise = runtime.agent.open({}).catch((caught: unknown) => caught);
    const disposePromise = runtime.dispose();
    rejectStart(new Error("no auth"));

    await openPromise;
    await disposePromise;

    expect(fake.stopMock).toHaveBeenCalledTimes(1); // cleanup from the failed start itself, not dispose
  });

  it("deterministically stops a ready runtime on dispose()", async () => {
    const fake = createFakeClient();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });
    await runtime.agent.open({});

    await runtime.dispose();

    expect(fake.stopMock).toHaveBeenCalledTimes(1);
  });

  it("is safe to dispose() a ready runtime even when its stop() itself rejects", async () => {
    const fake = createFakeClient();
    fake.stopMock.mockRejectedValueOnce(new Error("stop failed"));
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });
    await runtime.agent.open({});

    await expect(runtime.dispose()).resolves.toBeUndefined();
  });

  it("is a no-op to dispose() a runtime that never started", async () => {
    const fake = createFakeClient();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });

    await runtime.dispose();

    expect(fake.stopMock).not.toHaveBeenCalled();
  });

  it("waits for an in-flight start to settle, then stops it, when disposed mid-start", async () => {
    let resolveStart: () => void = () => {};
    const startPromise = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const fake = createFakeClient({ start: () => startPromise });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });

    const openPromise = runtime.agent.open({});
    const disposePromise = runtime.dispose();
    resolveStart();

    await openPromise;
    await disposePromise;

    expect(fake.stopMock).toHaveBeenCalledTimes(1);
  });

  it("is safe to dispose() mid-start even when the started runtime's own stop() rejects", async () => {
    let resolveStart: () => void = () => {};
    const startPromise = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const fake = createFakeClient({ start: () => startPromise });
    fake.stopMock.mockRejectedValueOnce(new Error("stop failed"));
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });

    const openPromise = runtime.agent.open({});
    const disposePromise = runtime.dispose();
    resolveStart();

    await openPromise;
    await expect(disposePromise).resolves.toBeUndefined();
  });

  it("rejects a new open() by name after dispose(), never silently starting a fresh runtime", async () => {
    const fake = createFakeClient();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });
    await runtime.dispose();

    const error: unknown = await runtime.agent.open({}).catch((caught: unknown) => caught);

    expect(isAgentError(error) ? error.code : undefined).toBe("agent_startup_failed");
  });

  it("logs safe operational metadata only, never prompt or response content", async () => {
    const fake = createFakeClient();
    const log = vi.fn();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client,
      log
    });
    const session = await runtime.agent.open({});
    await session.send("secret prompt text");

    for (const call of log.mock.calls) {
      const record = call[0] as { durationMs: number; event: string; status: string };
      expect(typeof record.durationMs).toBe("number");
      expect(record).not.toHaveProperty("content");
      expect(record).not.toHaveProperty("prompt");
      expect(JSON.stringify(record)).not.toContain("secret prompt text");
    }
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "runtime_start", status: "ok" })
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "session_open", status: "ok" })
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "agent_turn", status: "ok" })
    );
  });
});
