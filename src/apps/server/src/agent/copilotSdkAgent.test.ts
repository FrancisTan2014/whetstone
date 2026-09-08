import { describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@github/copilot-sdk";

import { isAgentError } from "./agentFailure.js";
import type { AgentSessionConfig } from "./agentSession.js";
import type { CopilotSdkConfig, ReasoningEffort } from "./copilotSdkConfig.js";
import {
  buildCopilotClientOptions,
  buildCopilotSessionConfig,
  type CopilotIdleScheduler,
  type CopilotRuntimeClient,
  type CopilotRuntimeSession,
  type CopilotStopOutcome,
  type CopilotTurnOutcome,
  createCopilotSdkAgentRuntime,
  denyAllCopilotPermissions,
  mapSdkClient,
  mapSdkSession,
  type SdkClientLike,
  type SdkSessionLike
} from "./copilotSdkAgent.js";

const fakeConfig: CopilotSdkConfig = {
  copilotHome: "C:\\fake\\copilot-home",
  model: "gpt-5.4",
  reasoningEffort: "high"
};

const stopped: CopilotStopOutcome = { kind: "stopped", errors: [] };

// ------------------------------------------------------------------------------------------------
// Pure builder / prompt-only enforcement coverage: no client, no runtime, no timers involved.
// ------------------------------------------------------------------------------------------------

describe("buildCopilotClientOptions", () => {
  it("uses the seam's own scratch directory, the safe multi-user-server mode, and pins the stdio transport", () => {
    expect(buildCopilotClientOptions(fakeConfig)).toEqual({
      baseDirectory: fakeConfig.copilotHome,
      clientInfo: { applicationName: "whetstone" },
      connection: { kind: "stdio" },
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
      infiniteSessions: { enabled: false },
      manageScheduleEnabled: false,
      model: fakeConfig.model,
      onPermissionRequest: denyAllCopilotPermissions,
      reasoningEffort: fakeConfig.reasoningEffort,
      skipCustomInstructions: true
    });
    expect(sessionConfig).not.toHaveProperty("systemMessage");
    expect(sessionConfig).not.toHaveProperty("mcpServers");
    expect(sessionConfig).not.toHaveProperty("cloud");
  });

  it("carries instructions as the session's persistent system message when present", () => {
    const sessionConfig = buildCopilotSessionConfig(fakeConfig, { instructions: "Be terse." });

    expect(sessionConfig.systemMessage).toEqual({ mode: "replace", content: "Be terse." });
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
  overrides: Partial<{
    sendAndWait: CopilotRuntimeSession["sendAndWait"];
    abort: CopilotRuntimeSession["abort"];
    disconnect: CopilotRuntimeSession["disconnect"];
  }> = {}
): CopilotRuntimeSession & {
  sendAndWaitMock: ReturnType<typeof vi.fn>;
  abortMock: ReturnType<typeof vi.fn>;
  disconnectMock: ReturnType<typeof vi.fn>;
} {
  const sendAndWaitMock = vi.fn(
    overrides.sendAndWait ?? (async () => ({ content: "reply", kind: "ok" as const }))
  );
  const abortMock = vi.fn(overrides.abort ?? (async () => {}));
  const disconnectMock = vi.fn(overrides.disconnect ?? (async () => {}));
  return {
    abort: abortMock,
    abortMock,
    disconnect: disconnectMock,
    disconnectMock,
    sendAndWait: sendAndWaitMock,
    sendAndWaitMock
  };
}

function createFakeClient(
  overrides: {
    start?: CopilotRuntimeClient["start"];
    listModels?: CopilotRuntimeClient["listModels"];
    createSession?: CopilotRuntimeClient["createSession"];
    stop?: CopilotRuntimeClient["stop"];
  } = {}
) {
  const startMock = vi.fn(overrides.start ?? (async () => {}));
  const listModelsMock = vi.fn(
    overrides.listModels ??
      (async () => [
        { id: fakeConfig.model, supportedReasoningEfforts: [fakeConfig.reasoningEffort] }
      ])
  );
  const stopMock = vi.fn(overrides.stop ?? (async () => stopped));
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

  it("passes the caller's own session config straight through to the runtime client", async () => {
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
    const log = vi.fn();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => failing.client,
      log
    });

    const error: unknown = await runtime.agent.open({}).catch((caught: unknown) => caught);

    expect(isAgentError(error) ? error.code : undefined).toBe("agent_startup_failed");
    expect(isAgentError(error) ? error.message : undefined).toContain("no auth");
    // The cleanup failure is itself observable, not silently discarded (#923).
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "runtime_stop", status: "agent_transport_failed" })
    );
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
          sendAndWait: async () => ({
            content: "a family of senses",
            kind: "ok",
            model: fakeConfig.model,
            reasoningEffort: "high"
          })
        })
    });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });
    const session = await runtime.agent.open({});

    await expect(session.send("hi")).resolves.toEqual({
      text: "a family of senses",
      model: fakeConfig.model,
      reasoningEffort: "high"
    });
  });

  it("rejects overlapping turns within a session and permits the next turn after completion", async () => {
    let resolveFirst: (outcome: CopilotTurnOutcome) => void = () => {};
    const sendAndWait = vi
      .fn<(prompt: string, timeoutMs: number) => Promise<CopilotTurnOutcome>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementationOnce(async () => ({ content: "second turn's reply", kind: "ok" }));
    const fake = createFakeClient({
      createSession: async () => createFakeSession({ sendAndWait })
    });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });
    const session = await runtime.agent.open({});

    const firstSend = session.send("first, slow");
    await expect(session.send("overlapping")).rejects.toMatchObject({
      code: "agent_transport_failed",
      message: expect.stringContaining("already has a turn")
    });
    expect(sendAndWait).toHaveBeenCalledTimes(1);
    resolveFirst({ content: "first turn's reply", kind: "ok" });
    await expect(firstSend).resolves.toEqual({ text: "first turn's reply" });
    await expect(session.send("next")).resolves.toEqual({ text: "second turn's reply" });
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

  it("reports a rejected disconnect and invalidates the runtime", async () => {
    const fake = createFakeClient({
      createSession: async () =>
        createFakeSession({ disconnect: () => Promise.reject(new Error("gone")) })
    });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });
    const session = await runtime.agent.open({});

    await expect(session.close()).rejects.toMatchObject({ code: "agent_transport_failed" });
    expect(fake.stopMock).toHaveBeenCalledTimes(1);
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

  it("shares close completion and bounds a failed cancellation and drain", async () => {
    let finishTurn: (value: CopilotTurnOutcome) => void = () => {};
    const fakeSession = createFakeSession({
      abort: () => new Promise(() => {}),
      sendAndWait: () =>
        new Promise((resolve) => {
          finishTurn = resolve;
        })
    });
    const fake = createFakeClient({ createSession: async () => fakeSession });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client,
      cleanupTimeoutMs: 10
    });
    const session = await runtime.agent.open({});
    const turn = session.send("synthetic pending turn");
    const firstClose = session.close();
    expect(session.close()).toBe(firstClose);
    await expect(firstClose).rejects.toMatchObject({
      code: "agent_transport_failed",
      message: expect.stringContaining("session drain timed out")
    });
    expect(fakeSession.disconnectMock).toHaveBeenCalledTimes(1);
    expect(fake.stopMock).toHaveBeenCalledTimes(1);
    finishTurn({ kind: "ok", content: "late result" });
    await turn;
    await runtime.dispose();
  });

  it("reports cancellation and drain failures instead of claiming the session closed cleanly", async () => {
    let rejectSend: (error: Error) => void = () => {};
    const sendAndWait = vi.fn(
      () =>
        new Promise<CopilotTurnOutcome>((_resolve, reject) => {
          rejectSend = reject;
        })
    );
    const fake = createFakeClient({
      createSession: async () =>
        createFakeSession({
          abort: () => Promise.reject(new Error("abort rpc failed")),
          sendAndWait
        })
    });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });
    const session = await runtime.agent.open({});

    const sendPromise = session.send("hi").catch(() => {});
    const closePromise = session.close();
    rejectSend(new Error("connection dropped mid-turn"));

    await expect(closePromise).rejects.toMatchObject({
      code: "agent_transport_failed",
      message: expect.stringContaining("abort rpc failed")
    });
    await sendPromise;
  });

  it("cancels and drains an in-flight turn via abort() before close() frees the session (#923)", async () => {
    let resolveSend: (outcome: CopilotTurnOutcome) => void = () => {};
    const sendAndWait = vi.fn(
      () =>
        new Promise<CopilotTurnOutcome>((resolve) => {
          resolveSend = resolve;
        })
    );
    const fakeSession = createFakeSession({ sendAndWait });
    const fake = createFakeClient({ createSession: async () => fakeSession });
    const idle = createFakeScheduler();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client,
      idleScheduler: idle.scheduler
    });
    const session = await runtime.agent.open({});

    const sendPromise = session.send("hi").catch((caught: unknown) => caught);
    const closePromise = session.close();

    await vi.waitFor(() => expect(fakeSession.abortMock).toHaveBeenCalledTimes(1));
    // The turn has not settled yet: close() must not have freed this session's slot, so idle
    // disposal is not yet eligible even though close() has already been called (#923).
    expect(idle.scheduled).toHaveLength(0);

    resolveSend({ kind: "timeout" });
    await closePromise;
    await sendPromise;

    expect(idle.scheduled).toHaveLength(1);
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

  it("logs a failed status when the idle-triggered stop() itself reports cleanup errors", async () => {
    const fake = createFakeClient({
      stop: async () => ({ kind: "failed", errors: ["stop failed"] })
    });
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
        expect.objectContaining({ event: "runtime_stop", status: "agent_transport_failed" })
      )
    );
  });

  it("serializes stop and start: a concurrent open() during an idle stop waits for it, then starts fresh", async () => {
    let resolveStop: (result: CopilotStopOutcome) => void = () => {};
    const stopPromise = new Promise<CopilotStopOutcome>((resolve) => {
      resolveStop = resolve;
    });
    const fake = createFakeClient({ stop: () => stopPromise });
    const idle = createFakeScheduler();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client,
      idleScheduler: idle.scheduler
    });

    const session1 = await runtime.agent.open({});
    await session1.close();
    idle.fireLatest(); // begins the idle stop, which now hangs on stopPromise

    const openPromise = runtime.agent.open({});
    await vi.waitFor(() => expect(fake.startMock).toHaveBeenCalledTimes(1));
    // The new open() must wait for the in-flight stop to fully settle before starting a replacement
    // -- never two live runtimes for the same slot at once (#923).
    expect(fake.startMock).toHaveBeenCalledTimes(1);

    resolveStop(stopped);
    await expect(openPromise).resolves.toBeDefined();
    expect(fake.startMock).toHaveBeenCalledTimes(2);
  });

  it("retains a runtime after failed cleanup and starts no replacement until cleanup succeeds", async () => {
    const first = createFakeClient({
      stop: async () => ({ kind: "failed", errors: ["runtime still owns a process"] })
    });
    const replacement = createFakeClient();
    const factory = vi.fn().mockReturnValueOnce(first.client).mockReturnValue(replacement.client);
    const idle = createFakeScheduler();
    const log = vi.fn();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: factory,
      idleScheduler: idle.scheduler,
      log
    });
    await (await runtime.agent.open({})).close();
    idle.fireLatest();
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ event: "runtime_stop", status: "agent_transport_failed" })
      )
    );
    await expect(runtime.agent.open({})).rejects.toMatchObject({
      code: "agent_transport_failed",
      message: expect.stringContaining("could not be stopped")
    });
    expect(factory).toHaveBeenCalledTimes(1);
    first.stopMock.mockResolvedValueOnce(stopped);
    const next = await runtime.agent.open({});
    expect(factory).toHaveBeenCalledTimes(2);
    expect(first.stopMock).toHaveBeenCalledTimes(3);
    await next.close();
    await runtime.dispose();
  });

  it("retries ownership cleanup on explicit disposal after an idle cleanup failure", async () => {
    const fake = createFakeClient({
      stop: async () => ({ kind: "failed", errors: ["cannot stop"] })
    });
    const idle = createFakeScheduler();
    const log = vi.fn();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client,
      idleScheduler: idle.scheduler,
      log
    });
    await (await runtime.agent.open({})).close();
    idle.fireLatest();
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "runtime_stop" }))
    );
    fake.stopMock.mockResolvedValueOnce(stopped);
    await runtime.dispose();
    expect(fake.stopMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates a runtime after a send() transport failure, without harming a newer generation later", async () => {
    const gen1 = createFakeClient({
      createSession: async () =>
        createFakeSession({
          sendAndWait: async () => ({ kind: "failed", message: "connection reset" })
        })
    });
    const gen2 = createFakeClient();
    const factory = vi.fn().mockReturnValueOnce(gen1.client).mockReturnValueOnce(gen2.client);
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: factory
    });

    const session1 = await runtime.agent.open({});
    await expect(session1.send("hi")).rejects.toMatchObject({ code: "agent_transport_failed" });
    await vi.waitFor(() => expect(gen1.stopMock).toHaveBeenCalledTimes(1));

    // The next explicit open() gets a fresh runtime instead of reusing gen1's now-dead transport.
    await expect(runtime.agent.open({})).resolves.toBeDefined();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(gen2.startMock).toHaveBeenCalledTimes(1);

    // A late failure on the STALE session1 (still bound to gen1) must not tear down gen2, the runtime
    // that is now actually active (#923).
    gen2.stopMock.mockClear();
    await expect(session1.send("hi again")).rejects.toMatchObject({
      code: "agent_transport_failed"
    });
    expect(gen2.stopMock).not.toHaveBeenCalled();
  });

  it("invalidates a runtime whose createSession fails while ready, so the next open() gets a fresh one", async () => {
    const gen1 = createFakeClient({
      createSession: () => Promise.reject(new Error("rpc dropped"))
    });
    const gen2 = createFakeClient();
    const factory = vi.fn().mockReturnValueOnce(gen1.client).mockReturnValueOnce(gen2.client);
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: factory
    });

    const firstError: unknown = await runtime.agent.open({}).catch((caught: unknown) => caught);
    expect(isAgentError(firstError) ? firstError.code : undefined).toBe("agent_transport_failed");
    expect(gen1.startMock).toHaveBeenCalledTimes(1); // start itself succeeded; only createSession failed

    await expect(runtime.agent.open({})).resolves.toBeDefined();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(gen2.startMock).toHaveBeenCalledTimes(1);
  });

  it("returns the same shutdown promise to every dispose() caller (idempotent)", async () => {
    let resolveStop: (result: CopilotStopOutcome) => void = () => {};
    const fake = createFakeClient({
      stop: () =>
        new Promise((resolve) => {
          resolveStop = resolve;
        })
    });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });
    await runtime.agent.open({});

    const d1 = runtime.dispose();
    const d2 = runtime.dispose();
    expect(d1).toBe(d2);

    resolveStop(stopped);
    await Promise.all([d1, d2]);

    expect(fake.stopMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op to dispose a runtime that was never opened (still cold)", async () => {
    const fake = createFakeClient();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });

    await expect(runtime.dispose()).resolves.toBeUndefined();

    expect(fake.startMock).not.toHaveBeenCalled();
    expect(fake.stopMock).not.toHaveBeenCalled();
  });

  it("fences a pending open() against a dispose() that settles from an already-ready runtime", async () => {
    const fake = createFakeClient();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });
    const session1 = await runtime.agent.open({});
    await session1.close(); // warmState stays "ready"; idle timer merely scheduled, never fired
    fake.createSessionMock.mockClear();

    const openPromise = runtime.agent.open({}).catch((caught: unknown) => caught);
    const disposePromise = runtime.dispose();

    const result = await openPromise;
    await disposePromise;

    expect(isAgentError(result) ? result.code : undefined).toBe("agent_startup_failed");
    expect(fake.createSessionMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "closes a session whose creation finishes after disposal (cleanup rejects: %s)",
    async (rejectCleanup) => {
      let finishOpen: (session: CopilotRuntimeSession) => void = () => {};
      const created = createFakeSession({
        disconnect: rejectCleanup
          ? async () => {
              throw new Error("late disconnect failed");
            }
          : async () => {}
      });
      const fake = createFakeClient({
        createSession: () =>
          new Promise((resolve) => {
            finishOpen = resolve;
          })
      });
      const runtime = createCopilotSdkAgentRuntime({
        config: fakeConfig,
        createRuntimeClient: () => fake.client
      });
      const opening = runtime.agent.open({});
      const rejected = expect(opening).rejects.toMatchObject({
        code: rejectCleanup ? "agent_transport_failed" : "agent_startup_failed"
      });
      await vi.waitFor(() => expect(fake.createSessionMock).toHaveBeenCalledTimes(1));
      await runtime.dispose();
      finishOpen(created);
      await rejected;
      expect(created.disconnectMock).toHaveBeenCalledTimes(1);
      expect(created.sendAndWaitMock).not.toHaveBeenCalled();
    }
  );

  it("reports failed startup cleanup to a racing disposal instead of claiming shutdown succeeded", async () => {
    let failStart: (error: Error) => void = () => {};
    const fake = createFakeClient({
      start: () =>
        new Promise((_resolve, reject) => {
          failStart = reject;
        }),
      stop: async () => ({ kind: "failed", errors: ["failed to terminate"] })
    });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });
    const failedOpen = expect(runtime.agent.open({})).rejects.toMatchObject({
      code: "agent_startup_failed"
    });
    const failedDisposal = expect(runtime.dispose()).rejects.toMatchObject({
      code: "agent_transport_failed"
    });
    failStart(new Error("authentication failed"));
    await Promise.all([failedOpen, failedDisposal]);
    await expect(runtime.agent.open({})).rejects.toMatchObject({ code: "agent_startup_failed" });
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

  it("stops the runtime once its in-flight start succeeds, when dispose() raced that start", async () => {
    let resolveStart: () => void = () => {};
    const startPromise = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const fake = createFakeClient({ start: () => startPromise });
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });

    const openPromise = runtime.agent.open({}).catch((caught: unknown) => caught);
    const disposePromise = runtime.dispose();
    resolveStart();

    const result = await openPromise;
    await disposePromise;

    // The start itself succeeded, but the runtime was already claimed as disposed before open() could
    // create a session on it -- dispose() must still stop the runtime that its own race let finish
    // starting, rather than leaving it resident with nothing tracking it (#923).
    expect(isAgentError(result) ? result.code : undefined).toBe("agent_startup_failed");
    expect(fake.stopMock).toHaveBeenCalledTimes(1);
  });

  it("logs a failed status when dispose() stops a runtime whose in-flight start just succeeded, and stop() reports errors", async () => {
    let resolveStart: () => void = () => {};
    const startPromise = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const fake = createFakeClient({
      start: () => startPromise,
      stop: async () => ({ kind: "failed", errors: ["dispose stop failed"] })
    });
    const log = vi.fn();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client,
      log
    });

    const openPromise = runtime.agent.open({}).catch((caught: unknown) => caught);
    const disposePromise = expect(runtime.dispose()).rejects.toMatchObject({
      code: "agent_transport_failed"
    });
    resolveStart();
    await openPromise;
    await disposePromise;

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "runtime_stop", status: "agent_transport_failed" })
    );
  });

  it("waits out an already in-flight stop rather than starting a second one, when dispose() races it", async () => {
    let resolveStop: (result: CopilotStopOutcome) => void = () => {};
    const stopPromise = new Promise<CopilotStopOutcome>((resolve) => {
      resolveStop = resolve;
    });
    const fake = createFakeClient({ stop: () => stopPromise });
    const idle = createFakeScheduler();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client,
      idleScheduler: idle.scheduler
    });
    const session1 = await runtime.agent.open({});
    await session1.close();
    idle.fireLatest(); // begins the idle stop, which now hangs on stopPromise
    expect(fake.stopMock).toHaveBeenCalledTimes(1);

    const disposePromise = runtime.dispose();
    resolveStop(stopped);
    await disposePromise;

    // Only the one, already in-flight stop() call ever happens -- dispose() never starts a redundant
    // second stop for the same runtime (#923).
    expect(fake.stopMock).toHaveBeenCalledTimes(1);
  });

  it("stops a ready runtime on dispose() and rejects any later open() by name", async () => {
    const fake = createFakeClient();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client
    });
    await runtime.agent.open({});

    await runtime.dispose();
    expect(fake.stopMock).toHaveBeenCalledTimes(1);

    const error: unknown = await runtime.agent.open({}).catch((caught: unknown) => caught);
    expect(isAgentError(error) ? error.code : undefined).toBe("agent_startup_failed");
  });

  it("logs a failed status when dispose() stops an already-ready runtime and stop() reports errors", async () => {
    const fake = createFakeClient({
      stop: async () => ({ kind: "failed", errors: ["dispose stop failed"] })
    });
    const log = vi.fn();
    const runtime = createCopilotSdkAgentRuntime({
      config: fakeConfig,
      createRuntimeClient: () => fake.client,
      log
    });
    await runtime.agent.open({});

    await expect(runtime.dispose()).rejects.toMatchObject({ code: "agent_transport_failed" });

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "runtime_stop", status: "agent_transport_failed" })
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
});

// ------------------------------------------------------------------------------------------------
// Real-SDK-shaped mapping coverage: `mapSdkSession`/`mapSdkClient` are ordinary, fully unit-tested
// logic driven against fakes shaped like the installed SDK's own `session.d.ts`/`client.d.ts`
// contracts (never an invented interface that hides real behavior) -- this is what lets the real
// factory's own `/* v8 ignore */` block stay to a single, genuinely unavoidable constructor line.
// ------------------------------------------------------------------------------------------------

function createFakeSdkSession(overrides: Partial<SdkSessionLike> = {}): SdkSessionLike & {
  sendAndWaitMock: ReturnType<typeof vi.fn>;
  abortMock: ReturnType<typeof vi.fn>;
} {
  const sendAndWaitMock = vi.fn(
    overrides.sendAndWait ?? (async () => ({ data: { content: "reply" } }))
  );
  const abortMock = vi.fn(overrides.abort ?? (async () => {}));
  return {
    abort: abortMock,
    abortMock,
    disconnect: overrides.disconnect ?? (async () => {}),
    on: overrides.on ?? (() => () => {}),
    sendAndWait: sendAndWaitMock,
    sendAndWaitMock
  };
}

describe("mapSdkSession", () => {
  it.each([
    ["gpt-5.4", "high"],
    ["gpt-5.6-luna", "high"],
    ["gpt-5.4", "medium"]
  ])(
    "reports actual model/effort %s/%s without asserting the configured request was honored",
    async (observedModel, effort) => {
      let receive: ((event: SessionEvent) => void) | undefined;
      const unsubscribe = vi.fn();
      const sdkSession = createFakeSdkSession({
        on: (handler) => {
          receive = handler;
          return unsubscribe;
        },
        sendAndWait: async () => {
          receive?.({
            type: "assistant.usage",
            ephemeral: true,
            id: "usage",
            parentId: null,
            timestamp: "2026-09-08T00:00:00Z",
            data: { model: observedModel, reasoningEffort: effort }
          });
          return { data: { content: "explanation" } };
        }
      });
      const session = await mapSdkClient(
        createFakeSdkClient({ createSession: async () => sdkSession }),
        fakeConfig
      ).createSession({});
      await expect(session.sendAndWait("term", 1000)).resolves.toMatchObject({
        kind: "ok",
        model: observedModel,
        reasoningEffort: effort
      });
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    }
  );

  it("does not borrow attribution from a subagent or the preceding turn", async () => {
    let receive: ((event: SessionEvent) => void) | undefined;
    let call = 0;
    const sdkSession = createFakeSdkSession({
      on: (handler) => {
        receive = handler;
        return () => {};
      },
      sendAndWait: async () => {
        call += 1;
        const event: SessionEvent = {
          type: "assistant.usage",
          ephemeral: true,
          id: "usage",
          parentId: null,
          timestamp: "2026-09-08T00:00:00Z",
          data: { model: "gpt-5.4" },
          ...(call === 1 ? {} : { agentId: "other-agent" })
        };
        receive?.(event);
        receive?.({
          type: "session.idle",
          ephemeral: true,
          id: "idle",
          parentId: null,
          timestamp: "2026-09-08T00:00:00Z",
          data: {}
        });
        return { data: { content: "reply" } };
      }
    });
    const session = mapSdkSession(sdkSession);
    await expect(session.sendAndWait("first", 1000)).resolves.toEqual({
      kind: "ok",
      content: "reply",
      model: "gpt-5.4"
    });
    await expect(session.sendAndWait("second", 1000)).resolves.toEqual({
      kind: "ok",
      content: "reply"
    });
  });

  it("maps a resolved assistant message to an ok outcome", async () => {
    const sdkSession = createFakeSdkSession({
      sendAndWait: async () => ({ data: { content: "a family of senses" } })
    });

    await expect(mapSdkSession(sdkSession).sendAndWait("hi", 1000)).resolves.toEqual({
      content: "a family of senses",
      kind: "ok"
    });
  });

  it("maps an undefined assistant message (no reply) to a failed outcome", async () => {
    const sdkSession = createFakeSdkSession({ sendAndWait: async () => undefined });

    await expect(mapSdkSession(sdkSession).sendAndWait("hi", 1000)).resolves.toEqual({
      kind: "failed",
      message: expect.stringContaining("no assistant message")
    });
  });

  it("maps a generic rejection to a failed outcome carrying its message", async () => {
    const sdkSession = createFakeSdkSession({
      sendAndWait: () => Promise.reject(new Error("connection reset"))
    });

    await expect(mapSdkSession(sdkSession).sendAndWait("hi", 1000)).resolves.toEqual({
      kind: "failed",
      message: "connection reset"
    });
  });

  it("does not classify an upstream timeout message as its own deadline", async () => {
    const sdkSession = createFakeSdkSession({
      sendAndWait: () => Promise.reject(new Error("Timeout after 60000ms waiting for session.idle"))
    });

    await expect(mapSdkSession(sdkSession).sendAndWait("hi", 1000)).resolves.toEqual({
      kind: "failed",
      message: "Timeout after 60000ms waiting for session.idle"
    });
    expect(sdkSession.abortMock).not.toHaveBeenCalled();
  });

  it("aborts the session and reports a timeout when send() itself never acknowledges (owned deadline)", async () => {
    // The SDK's own `timeout` only starts its internal timer AFTER `send()` resolves (session.js): a
    // hang before that point is never caught by the SDK at all. This seam's own owned deadline must
    // still bound -- and cancel -- it.
    const sdkSession = createFakeSdkSession({ sendAndWait: () => new Promise(() => {}) });

    await expect(mapSdkSession(sdkSession).sendAndWait("hi", 20)).resolves.toEqual({
      kind: "timeout"
    });
    expect(sdkSession.abortMock).toHaveBeenCalledTimes(1);
  });

  it("reports a failed cancellation when the owned deadline expires", async () => {
    const sdkSession = createFakeSdkSession({
      sendAndWait: () => new Promise(() => {}),
      abort: () => Promise.reject(new Error("abort rpc failed"))
    });

    await expect(mapSdkSession(sdkSession).sendAndWait("hi", 20)).resolves.toEqual({
      kind: "failed",
      message: expect.stringContaining("cancellation failed: abort rpc failed")
    });
  });

  it("bounds cancellation when a timed-out turn cannot acknowledge abort", async () => {
    const sdkSession = createFakeSdkSession({
      sendAndWait: () => new Promise(() => {}),
      abort: () => new Promise(() => {})
    });
    await expect(mapSdkSession(sdkSession, 10).sendAndWait("hi", 10)).resolves.toMatchObject({
      kind: "failed",
      message: expect.stringContaining("session abort timed out")
    });
    expect(sdkSession.abortMock).toHaveBeenCalledTimes(1);
  });

  it("delegates abort() and disconnect() directly", async () => {
    const sdkSession = createFakeSdkSession();
    const disconnectMock = vi.fn(async () => {});
    const session = mapSdkSession({ ...sdkSession, disconnect: disconnectMock });

    await session.abort();
    await session.disconnect();

    expect(sdkSession.abortMock).toHaveBeenCalledTimes(1);
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });
});

function createFakeSdkClient(
  overrides: Partial<{
    start: SdkClientLike["start"];
    stop: SdkClientLike["stop"];
    forceStop: SdkClientLike["forceStop"];
    listModels: SdkClientLike["listModels"];
    createSession: SdkClientLike["createSession"];
  }> = {}
): SdkClientLike & {
  startMock: ReturnType<typeof vi.fn>;
  stopMock: ReturnType<typeof vi.fn>;
  forceStopMock: ReturnType<typeof vi.fn>;
  createSessionMock: ReturnType<typeof vi.fn>;
} {
  const startMock = vi.fn(overrides.start ?? (async () => {}));
  const stopMock = vi.fn(overrides.stop ?? (async () => [] as ReadonlyArray<Error>));
  const forceStopMock = vi.fn(overrides.forceStop ?? (async () => {}));
  const createSessionMock = vi.fn(overrides.createSession ?? (async () => createFakeSdkSession()));
  return {
    createSession: createSessionMock,
    createSessionMock,
    forceStop: forceStopMock,
    forceStopMock,
    listModels: overrides.listModels ?? (async () => []),
    start: startMock,
    startMock,
    stop: stopMock,
    stopMock
  };
}

// A real `ModelInfo` (types.d.ts) carries many fields this seam never reads (name, capabilities,
// policy, billing, defaultReasoningEffort...). Structural typing lets a value shaped like this satisfy
// `SdkClientLike.listModels()`'s narrower declared return type with no unsafe cast.
type ModelInfoWithExtraFields = Readonly<{
  id: string;
  supportedReasoningEfforts?: ReadonlyArray<ReasoningEffort>;
  name: string;
  capabilities: Readonly<Record<string, unknown>>;
}>;

describe("mapSdkClient", () => {
  it("projects listModels() results down to id and (when present) supportedReasoningEfforts only", async () => {
    const modelsWithExtraFields: ReadonlyArray<ModelInfoWithExtraFields> = [
      { capabilities: {}, id: "gpt-5.4", name: "GPT", supportedReasoningEfforts: ["high", "max"] },
      { capabilities: {}, id: "auto", name: "Auto" }
    ];
    const sdkClient = createFakeSdkClient({ listModels: async () => modelsWithExtraFields });

    await expect(mapSdkClient(sdkClient, fakeConfig).listModels()).resolves.toEqual([
      { id: "gpt-5.4", supportedReasoningEfforts: ["high", "max"] },
      { id: "auto" }
    ]);
  });

  it("creates a session through the full prompt-only session config and maps it via mapSdkSession", async () => {
    const sdkClient = createFakeSdkClient();

    const session = await mapSdkClient(sdkClient, fakeConfig).createSession({
      instructions: "Be terse."
    });

    expect(sdkClient.createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        availableTools: [],
        model: fakeConfig.model,
        systemMessage: { mode: "replace", content: "Be terse." }
      })
    );
    await expect(session.sendAndWait("hi", 1000)).resolves.toEqual({
      content: "reply",
      kind: "ok"
    });
  });

  it("delegates start() directly", async () => {
    const sdkClient = createFakeSdkClient();

    await mapSdkClient(sdkClient, fakeConfig).start();

    expect(sdkClient.startMock).toHaveBeenCalledTimes(1);
  });

  it("reports a clean stop() with no errors and never calls forceStop", async () => {
    const sdkClient = createFakeSdkClient();

    await expect(mapSdkClient(sdkClient, fakeConfig).stop()).resolves.toEqual(stopped);
    expect(sdkClient.forceStopMock).not.toHaveBeenCalled();
  });

  it("surfaces stop() errors and falls back to forceStop, preserving the original error", async () => {
    const sdkClient = createFakeSdkClient({
      stop: async () => [new Error("session close failed")]
    });

    const errors = await mapSdkClient(sdkClient, fakeConfig).stop();

    expect(errors).toEqual({ kind: "stopped", errors: ["session close failed"] });
    expect(sdkClient.forceStopMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a thrown stop() as an error too, still falling back to forceStop", async () => {
    const sdkClient = createFakeSdkClient({
      stop: () => Promise.reject(new Error("stop rpc failed"))
    });

    const errors = await mapSdkClient(sdkClient, fakeConfig).stop();

    expect(errors).toEqual({ kind: "stopped", errors: ["stop rpc failed"] });
    expect(sdkClient.forceStopMock).toHaveBeenCalledTimes(1);
  });

  it("bounds an unresponsive graceful stop before using forceStop", async () => {
    const sdkClient = createFakeSdkClient({ stop: () => new Promise(() => {}) });
    await expect(mapSdkClient(sdkClient, fakeConfig, 10).stop()).resolves.toEqual({
      kind: "stopped",
      errors: [expect.stringContaining("runtime stop timed out")]
    });
    expect(sdkClient.forceStopMock).toHaveBeenCalledTimes(1);
  });

  it("appends a forceStop failure rather than swallowing it, never fabricating a clean stop", async () => {
    const sdkClient = createFakeSdkClient({
      stop: async () => [new Error("session close failed")],
      forceStop: () => Promise.reject(new Error("force stop also failed"))
    });

    const errors = await mapSdkClient(sdkClient, fakeConfig).stop();

    expect(errors).toEqual({
      kind: "failed",
      errors: ["session close failed", expect.stringContaining("force stop also failed")]
    });
  });

  it("bounds a hanging forceStop fallback rather than letting shutdown hang forever", async () => {
    const sdkClient = createFakeSdkClient({
      stop: async () => [new Error("session close failed")],
      forceStop: () => new Promise(() => {})
    });

    const errors = await mapSdkClient(sdkClient, fakeConfig, 20).stop();

    expect(errors).toEqual({
      kind: "failed",
      errors: ["session close failed", expect.stringContaining("timed out")]
    });
  });

  it("wraps a non-Error forceStop rejection as an Error rather than propagating it as-is", async () => {
    const sdkClient = createFakeSdkClient({
      stop: async () => [new Error("session close failed")],
      forceStop: () => Promise.reject("force stop rejected with a plain string")
    });

    const errors = await mapSdkClient(sdkClient, fakeConfig).stop();

    expect(errors).toEqual({
      kind: "failed",
      errors: [
        "session close failed",
        expect.stringContaining("force stop rejected with a plain string")
      ]
    });
  });
});
