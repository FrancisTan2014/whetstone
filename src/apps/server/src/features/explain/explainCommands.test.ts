import { describe, expect, it, vi } from "vitest";

import type { ExplainRequest } from "@whetstone/contracts";

import type { Agent, AgentSession } from "../../agent/agentSession.js";
import type { DbClient } from "../../db/dbClient.js";
import { createExplainInFlightCoalescer, createInMemoryExplainCache } from "./explainCache.js";
import { explainSelection, type ExplainCommandDependencies } from "./explainCommands.js";
import type { ExplainSourceOutcome } from "./explainSourceResolution.js";
import type { ExplainTurnScheduler } from "./explainTurn.js";

const fakeDb = {} as DbClient;

function request(overrides: Partial<ExplainRequest> = {}): ExplainRequest {
  return {
    blockEntryId: "block-1" as ExplainRequest["blockEntryId"],
    endOffset: 10,
    selectedText: "hello",
    startOffset: 5,
    workEntryId: "work-1" as ExplainRequest["workEntryId"],
    ...overrides
  };
}

function okSource(
  overrides: Partial<Extract<ExplainSourceOutcome, { status: "ok" }>["source"]> = {}
) {
  return {
    status: "ok" as const,
    source: {
      context: "a sentence with hello in it",
      contentRevision: 1,
      headword: "hello",
      language: "en" as const,
      ...overrides
    }
  };
}

function validModelJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    currentBranchId: "branch-1",
    currentFamilyId: "family-1",
    families: [
      {
        branches: [
          { connection: "extends the core", example: "an example", id: "branch-1", label: "one" }
        ],
        coreImage: "a shared core image",
        id: "family-1"
      }
    ],
    headword: "hello",
    language: "en",
    ...overrides
  });
}

function fakeAgent(
  sendImpl: () => Promise<{ text: string; model?: string; reasoningEffort?: string }>
): {
  agent: Agent;
  openMock: ReturnType<typeof vi.fn>;
  closeMock: ReturnType<typeof vi.fn>;
} {
  const closeMock = vi.fn().mockResolvedValue(undefined);
  const session: AgentSession = { close: closeMock, send: sendImpl };
  const openMock = vi.fn().mockResolvedValue(session);
  return { agent: { open: openMock }, closeMock, openMock };
}

function baseDependencies(
  overrides: Partial<ExplainCommandDependencies> = {}
): ExplainCommandDependencies {
  return {
    cache: createInMemoryExplainCache(),
    coalescer: createExplainInFlightCoalescer(),
    db: fakeDb,
    model: "gpt-5.4",
    reasoningEffort: "high",
    ...overrides
  };
}

describe("explainSelection — disabled", () => {
  it("returns disabled without touching the database when no agent is configured", async () => {
    const resolveSource = vi.fn();
    const dependencies = baseDependencies({ resolveSource });

    const response = await explainSelection(dependencies, request());

    expect(response).toEqual({ status: "disabled" });
    expect(resolveSource).not.toHaveBeenCalled();
  });
});

describe("explainSelection — source resolution outcomes", () => {
  it("passes through a not_found source outcome", async () => {
    const { agent } = fakeAgent(() => Promise.resolve({ text: validModelJson() }));
    const resolveSource = vi.fn().mockResolvedValue({ status: "not_found" });
    const dependencies = baseDependencies({ agent, resolveSource });

    await expect(explainSelection(dependencies, request())).resolves.toEqual({
      status: "not_found"
    });
  });

  it("passes through a stale_selection source outcome", async () => {
    const { agent } = fakeAgent(() => Promise.resolve({ text: validModelJson() }));
    const resolveSource = vi.fn().mockResolvedValue({ status: "stale_selection" });
    const dependencies = baseDependencies({ agent, resolveSource });

    await expect(explainSelection(dependencies, request())).resolves.toEqual({
      status: "stale_selection"
    });
  });
});

describe("explainSelection — successful turn", () => {
  it("returns an ok result with observed provider attribution", async () => {
    const { agent } = fakeAgent(() =>
      Promise.resolve({ model: "gpt-5.6-luna", reasoningEffort: "high", text: validModelJson() })
    );
    const resolveSource = vi.fn().mockResolvedValue(okSource());
    const dependencies = baseDependencies({ agent, resolveSource });

    const response = await explainSelection(dependencies, request());

    expect(response.status).toBe("ok");
    if (response.status === "ok") {
      expect(response.provider).toEqual({ model: "gpt-5.6-luna", reasoningEffort: "high" });
      expect(response.result.headword).toBe("hello");
    }
  });

  it("omits provider fields the runtime never reported, rather than fabricating them", async () => {
    const { agent } = fakeAgent(() => Promise.resolve({ text: validModelJson() }));
    const resolveSource = vi.fn().mockResolvedValue(okSource());
    const dependencies = baseDependencies({ agent, resolveSource });

    const response = await explainSelection(dependencies, request());

    expect(response.status).toBe("ok");
    if (response.status === "ok") {
      expect(response.provider).toEqual({});
    }
  });
});

describe("explainSelection — invalid model output", () => {
  it("reports invalid_response for malformed JSON", async () => {
    const { agent } = fakeAgent(() => Promise.resolve({ text: "not json at all" }));
    const resolveSource = vi.fn().mockResolvedValue(okSource());
    const dependencies = baseDependencies({ agent, resolveSource });

    await expect(explainSelection(dependencies, request())).resolves.toEqual({
      status: "invalid_response"
    });
  });

  it("reports invalid_response when the model answers in the wrong language", async () => {
    const { agent } = fakeAgent(() =>
      Promise.resolve({ text: validModelJson({ language: "zh" }) })
    );
    const resolveSource = vi.fn().mockResolvedValue(okSource({ language: "en" }));
    const dependencies = baseDependencies({ agent, resolveSource });

    await expect(explainSelection(dependencies, request())).resolves.toEqual({
      status: "invalid_response"
    });
  });

  it("never caches an invalid_response outcome", async () => {
    const { agent, openMock } = fakeAgent(() => Promise.resolve({ text: "not json" }));
    const resolveSource = vi.fn().mockResolvedValue(okSource());
    const cache = createInMemoryExplainCache<never>();
    const dependencies = baseDependencies({ agent, cache: cache as never, resolveSource });

    await explainSelection(dependencies, request());
    await explainSelection(dependencies, request());

    expect(openMock).toHaveBeenCalledTimes(2);
  });
});

describe("explainSelection — timeout", () => {
  it("reports timeout and never caches it", async () => {
    let scheduledCallback: (() => void) | undefined;
    const scheduler: ExplainTurnScheduler = {
      cancel: () => {},
      schedule: (callback) => {
        scheduledCallback = callback;
        return "handle";
      }
    };
    const openPromise = new Promise<AgentSession>(() => {});
    const agent: Agent = { open: vi.fn().mockReturnValue(openPromise) };
    const resolveSource = vi.fn().mockResolvedValue(okSource());
    const dependencies = baseDependencies({ agent, resolveSource, scheduler, turnTimeoutMs: 5 });

    const outcomePromise = explainSelection(dependencies, request());
    await vi.waitFor(() => {
      if (scheduledCallback === undefined) {
        throw new Error("deadline not yet scheduled");
      }
    });
    scheduledCallback?.();

    await expect(outcomePromise).resolves.toEqual({ status: "timeout" });
  });
});

describe("explainSelection — unavailable", () => {
  it("maps a startup failure to the named unavailable reason", async () => {
    const { AgentError } = await import("../../agent/agentFailure.js");
    const agent: Agent = {
      open: vi.fn().mockRejectedValue(new AgentError("agent_startup_failed", "no auth"))
    };
    const resolveSource = vi.fn().mockResolvedValue(okSource());
    const dependencies = baseDependencies({ agent, resolveSource });

    await expect(explainSelection(dependencies, request())).resolves.toEqual({
      reason: "startup_failed",
      status: "unavailable"
    });
  });
});

describe("explainSelection — cache", () => {
  it("serves a second identical request from the cache without a second Copilot turn", async () => {
    const { agent, openMock } = fakeAgent(() => Promise.resolve({ text: validModelJson() }));
    const resolveSource = vi.fn().mockResolvedValue(okSource());
    const dependencies = baseDependencies({ agent, resolveSource });

    await explainSelection(dependencies, request());
    await explainSelection(dependencies, request());

    expect(openMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates the cache when the canonical content revision changes", async () => {
    const { agent, openMock } = fakeAgent(() => Promise.resolve({ text: validModelJson() }));
    const resolveSource = vi
      .fn()
      .mockResolvedValueOnce(okSource({ contentRevision: 1 }))
      .mockResolvedValueOnce(okSource({ contentRevision: 2 }));
    const dependencies = baseDependencies({ agent, resolveSource });

    await explainSelection(dependencies, request());
    await explainSelection(dependencies, request());

    expect(openMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent identical requests into a single Copilot turn", async () => {
    let resolveSend: ((turn: { text: string }) => void) | undefined;
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const sendMock = vi.fn(
      () =>
        new Promise<{ text: string }>((resolve) => {
          resolveSend = resolve;
        })
    );
    const openMock = vi.fn().mockResolvedValue({ close: closeMock, send: sendMock });
    const agent: Agent = { open: openMock };
    const resolveSource = vi.fn().mockResolvedValue(okSource());
    const dependencies = baseDependencies({ agent, resolveSource });

    const first = explainSelection(dependencies, request());
    const second = explainSelection(dependencies, request());

    await vi.waitFor(() => {
      if (resolveSend === undefined) {
        throw new Error("send not yet called");
      }
    });
    resolveSend?.({ text: validModelJson() });

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(firstResponse).toEqual(secondResponse);
  });

  it("recovers after a failure — a later identical request tries again rather than reusing the failure", async () => {
    const { AgentError } = await import("../../agent/agentFailure.js");
    const openMock = vi
      .fn()
      .mockRejectedValueOnce(new AgentError("agent_transport_failed", "boom"))
      .mockResolvedValueOnce({
        close: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue({ text: validModelJson() })
      });
    const agent: Agent = { open: openMock };
    const resolveSource = vi.fn().mockResolvedValue(okSource());
    const dependencies = baseDependencies({ agent, resolveSource });

    await expect(explainSelection(dependencies, request())).resolves.toEqual({
      reason: "transport_failed",
      status: "unavailable"
    });
    await expect(explainSelection(dependencies, request())).resolves.toMatchObject({
      status: "ok"
    });
    expect(openMock).toHaveBeenCalledTimes(2);
  });
});

describe("explainSelection — logging", () => {
  it("logs only duration and status, never the prompt, context, or model answer", async () => {
    const { agent } = fakeAgent(() => Promise.resolve({ text: validModelJson() }));
    const resolveSource = vi.fn().mockResolvedValue(okSource());
    const log = vi.fn();
    const dependencies = baseDependencies({ agent, log, resolveSource });

    await explainSelection(dependencies, request());

    expect(log).toHaveBeenCalledTimes(1);
    const [record] = log.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(record).sort()).toEqual(["durationMs", "status"]);
    expect(record.status).toBe("ok");
  });
});
