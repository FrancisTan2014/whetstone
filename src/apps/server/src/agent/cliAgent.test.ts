import { describe, expect, it, vi } from "vitest";

import { isAgentError } from "./agentFailure.js";
import type { AgentCommand, AgentCommandOutcome, AgentCommandRunner } from "./agentProcess.js";
import {
  agentContractVersion,
  createCliAgent,
  probeCliAgent,
  unknownProviderIdentifier,
  type AgentLogRecord,
  type CliAgentConfig
} from "./cliAgent.js";

const config: CliAgentConfig = { binaryPath: "local-agent", modelIdentifier: "qwen-coder" };

function probeStdout(fields: Record<string, unknown> = {}): AgentCommandOutcome {
  return {
    kind: "ok",
    stdout: JSON.stringify({ contractVersion: agentContractVersion, provider: "qwen", ...fields })
  };
}

function turnStdout(fields: Record<string, unknown>): AgentCommandOutcome {
  return { kind: "ok", stdout: JSON.stringify(fields) };
}

// A scripted process boundary: it records every command it was given and answers with the next queued
// outcome, so every adapter path is exercised without spawning anything.
function createScriptedRunner(outcomes: ReadonlyArray<AgentCommandOutcome>) {
  const queue = [...outcomes];
  const commands: AgentCommand[] = [];
  const run: AgentCommandRunner = (command) => {
    commands.push(command);
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("the scripted runner ran out of outcomes");
    }
    return Promise.resolve(next);
  };
  return { commands, run };
}

async function failureCode(action: Promise<unknown>): Promise<string> {
  const error: unknown = await action.then(
    () => undefined,
    (caught: unknown) => caught
  );
  if (!isAgentError(error)) {
    throw new Error(`expected an AgentError, got: ${String(error)}`);
  }
  return error.code;
}

async function failureMessage(action: Promise<unknown>): Promise<string> {
  const error: unknown = await action.then(
    () => undefined,
    (caught: unknown) => caught
  );
  return isAgentError(error) ? error.message : "";
}

describe("createCliAgent readiness probe", () => {
  it("probes with the contract-version argument, an empty prompt, and a short bound", async () => {
    const { commands, run } = createScriptedRunner([probeStdout()]);

    await createCliAgent({ config, run }).open({});

    expect(commands).toEqual([
      {
        args: ["--contract-version"],
        binaryPath: "local-agent",
        stdin: "",
        timeoutMs: 10_000
      }
    ]);
  });

  it("reports the provider identifier and session support from the probe", async () => {
    const { run } = createScriptedRunner([probeStdout({ sessions: true })]);

    await expect(probeCliAgent({ config, run })).resolves.toEqual({
      provider: "qwen",
      sessions: true
    });
  });

  it.each([
    ["an omitted sessions flag", probeStdout()],
    ["a non-boolean sessions flag", probeStdout({ sessions: "yes" })],
    ["an explicit false", probeStdout({ sessions: false })]
  ])("never assumes session support: %s reports false", async (_label, outcome) => {
    const { run } = createScriptedRunner([outcome]);

    await expect(probeCliAgent({ config, run })).resolves.toEqual({
      provider: "qwen",
      sessions: false
    });
  });

  it.each([
    ["a provider that reports no identifier", probeStdout({ provider: undefined })],
    ["a blank identifier", probeStdout({ provider: "   " })],
    ["a non-string identifier", probeStdout({ provider: 7 })]
  ])("falls back to a neutral identifier for %s", async (_label, outcome) => {
    const { run } = createScriptedRunner([outcome]);

    await expect(probeCliAgent({ config, run })).resolves.toEqual({
      provider: unknownProviderIdentifier,
      sessions: false
    });
  });

  it("fails the probe when the executable exits non-zero, carrying its stderr", async () => {
    const { run } = createScriptedRunner([
      { exitCode: 2, kind: "failed", stderr: "unknown flag --contract-version" }
    ]);

    const probe = probeCliAgent({ config, run });
    await expect(failureCode(probe)).resolves.toBe("agent_probe_failed");
    await expect(failureMessage(probe)).resolves.toContain("unknown flag --contract-version");
  });

  it("fails the probe when the executable exits non-zero silently", async () => {
    const { run } = createScriptedRunner([{ exitCode: 9, kind: "failed", stderr: "  " }]);

    await expect(failureMessage(probeCliAgent({ config, run }))).resolves.toContain(
      "exited with code 9"
    );
  });

  it("fails the probe when the executable never answers in time", async () => {
    const { run } = createScriptedRunner([{ kind: "timeout" }]);

    const probe = probeCliAgent({ config, run });
    await expect(failureCode(probe)).resolves.toBe("agent_probe_failed");
    await expect(failureMessage(probe)).resolves.toContain("did not respond in time");
  });

  it.each([
    ["output that is not JSON", { kind: "ok", stdout: "not json" } as AgentCommandOutcome],
    ["a non-object root", { kind: "ok", stdout: "7" } as AgentCommandOutcome],
    ["an array root", { kind: "ok", stdout: "[]" } as AgentCommandOutcome]
  ])("fails the probe on %s", async (_label, outcome) => {
    const { run } = createScriptedRunner([outcome]);

    await expect(failureCode(probeCliAgent({ config, run }))).resolves.toBe("agent_probe_failed");
  });

  it("fails the probe when the provider speaks a different contract version", async () => {
    const { run } = createScriptedRunner([probeStdout({ contractVersion: "2" })]);

    const probe = probeCliAgent({ config, run });
    await expect(failureCode(probe)).resolves.toBe("agent_probe_failed");
    await expect(failureMessage(probe)).resolves.toContain("contract version 2");
  });

  it("never hands a prompt to a provider whose probe failed", async () => {
    const { commands, run } = createScriptedRunner([{ kind: "timeout" }]);

    await expect(createCliAgent({ config, run }).open({})).rejects.toThrow();
    expect(commands).toHaveLength(1);
  });

  it("uses the real process boundary by default", async () => {
    // Node rejects the protocol's probe flag, exercising the default runner, clock, and log sink
    // end-to-end without any agent CLI installed.
    const agent = createCliAgent({
      config: { binaryPath: process.execPath, modelIdentifier: "m" }
    });

    await expect(failureCode(agent.open({}))).resolves.toBe("agent_probe_failed");
  });
});

describe("createCliAgent turns", () => {
  it("writes the prompt to stdin and returns the provider's text", async () => {
    const { commands, run } = createScriptedRunner([
      probeStdout(),
      turnStdout({ text: "the answer" })
    ]);

    const session = await createCliAgent({ config, run }).open({});

    await expect(session.send("what is a whetstone?")).resolves.toEqual({ text: "the answer" });
    expect(commands[1]).toEqual({
      args: ["--model", "qwen-coder", "--output", "json"],
      binaryPath: "local-agent",
      stdin: "what is a whetstone?",
      timeoutMs: 120_000
    });
  });

  it("grants the provider no tools", async () => {
    const { commands, run } = createScriptedRunner([probeStdout(), turnStdout({ text: "ok" })]);

    const session = await createCliAgent({ config, run }).open({});
    await session.send("hi");

    const args = commands[1]?.args.join(" ") ?? "";
    expect(args).not.toContain("tool");
    expect(args).not.toContain("allow");
  });

  it("ignores unknown response keys - only text is required", async () => {
    const { run } = createScriptedRunner([
      probeStdout(),
      turnStdout({ cost: 3, text: "kept", usage: { tokens: 12 } })
    ]);

    const session = await createCliAgent({ config, run }).open({});

    await expect(session.send("hi")).resolves.toEqual({ text: "kept" });
  });

  it("restates standing instructions ahead of every prompt", async () => {
    const { commands, run } = createScriptedRunner([
      probeStdout(),
      turnStdout({ text: "one" }),
      turnStdout({ text: "two" })
    ]);

    const session = await createCliAgent({ config, run }).open({ instructions: "Be terse." });
    await session.send("first");
    await session.send("second");

    expect(commands[1]?.stdin).toBe("Be terse.\n\nfirst");
    expect(commands[2]?.stdin).toBe("Be terse.\n\nsecond");
  });

  it("sends the prompt alone when the instructions are blank", async () => {
    const { commands, run } = createScriptedRunner([probeStdout(), turnStdout({ text: "ok" })]);

    const session = await createCliAgent({ config, run }).open({ instructions: "   " });
    await session.send("first");

    expect(commands[1]?.stdin).toBe("first");
  });

  it("keeps a conversation on one session id when the provider supports sessions", async () => {
    const { commands, run } = createScriptedRunner([
      probeStdout({ sessions: true }),
      turnStdout({ text: "one" }),
      turnStdout({ text: "two" })
    ]);

    const session = await createCliAgent({
      config,
      createSessionId: () => "session-1",
      run
    }).open({});
    await session.send("first");
    await session.send("second");

    const expected = ["--model", "qwen-coder", "--output", "json", "--session", "session-1"];
    expect(commands[1]?.args).toEqual(expected);
    expect(commands[2]?.args).toEqual(expected);
  });

  it("gives each opened conversation its own session id", async () => {
    const ids = ["session-1", "session-2"];
    const { commands, run } = createScriptedRunner([
      probeStdout({ sessions: true }),
      turnStdout({ text: "one" }),
      probeStdout({ sessions: true }),
      turnStdout({ text: "two" })
    ]);
    const agent = createCliAgent({ config, createSessionId: () => ids.shift() ?? "", run });

    await (await agent.open({})).send("first");
    await (await agent.open({})).send("second");

    expect(commands[1]?.args).toContain("session-1");
    expect(commands[3]?.args).toContain("session-2");
  });

  it("generates an opaque session id by default", async () => {
    const { commands, run } = createScriptedRunner([
      probeStdout({ sessions: true }),
      turnStdout({ text: "ok" })
    ]);

    const session = await createCliAgent({ config, run }).open({});
    await session.send("hi");

    const sessionId = commands[1]?.args.at(-1) ?? "";
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("passes no session argument to a provider that cannot resume state", async () => {
    const { commands, run } = createScriptedRunner([
      probeStdout({ sessions: false }),
      turnStdout({ text: "ok" })
    ]);

    const session = await createCliAgent({ config, run }).open({});
    await session.send("hi");

    expect(commands[1]?.args).not.toContain("--session");
  });

  it("fails a turn by name when the provider exits non-zero, carrying its stderr", async () => {
    const { run } = createScriptedRunner([
      probeStdout(),
      { exitCode: 1, kind: "failed", stderr: "model not pulled" }
    ]);

    const session = await createCliAgent({ config, run }).open({});
    const turn = session.send("hi");

    await expect(failureCode(turn)).resolves.toBe("agent_exit_failed");
    await expect(failureMessage(turn)).resolves.toContain("model not pulled");
  });

  it("describes a silent non-zero exit by its exit code", async () => {
    const { run } = createScriptedRunner([
      probeStdout(),
      { exitCode: null, kind: "failed", stderr: "" }
    ]);

    const session = await createCliAgent({ config, run }).open({});

    await expect(failureMessage(session.send("hi"))).resolves.toContain("exited with code null");
  });

  it("fails a turn by name when the provider exceeds its wall-clock bound", async () => {
    const { run } = createScriptedRunner([probeStdout(), { kind: "timeout" }]);

    const session = await createCliAgent({ config, run }).open({});

    await expect(failureCode(session.send("hi"))).resolves.toBe("agent_timeout");
  });

  it.each([
    ["output that is not JSON", { kind: "ok", stdout: "still thinking..." } as AgentCommandOutcome],
    ["a non-object root", { kind: "ok", stdout: '"text"' } as AgentCommandOutcome],
    ["a missing text field", turnStdout({ output: "wrong key" })],
    ["a non-string text field", turnStdout({ text: 42 })]
  ])("fails a turn by name, never fabricating an answer, on %s", async (_label, outcome) => {
    const { run } = createScriptedRunner([probeStdout(), outcome]);

    const session = await createCliAgent({ config, run }).open({});

    await expect(failureCode(session.send("hi"))).resolves.toBe("agent_malformed_response");
  });

  it("refuses another turn once the session is closed", async () => {
    const { commands, run } = createScriptedRunner([probeStdout(), turnStdout({ text: "ok" })]);

    const session = await createCliAgent({ config, run }).open({});
    await session.send("first");
    await session.close();
    await session.close();

    await expect(failureCode(session.send("second"))).resolves.toBe("agent_session_closed");
    expect(commands).toHaveLength(2);
  });
});

describe("createCliAgent operational logging", () => {
  function createLog() {
    const records: AgentLogRecord[] = [];
    return { log: (record: AgentLogRecord) => records.push(record), records };
  }

  it("logs the provider, outcome, and duration of a probe and a turn", async () => {
    const { log, records } = createLog();
    const { run } = createScriptedRunner([probeStdout(), turnStdout({ text: "answer" })]);
    const clock = vi
      .fn(() => 0)
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(340)
      .mockReturnValueOnce(500)
      .mockReturnValueOnce(1250);

    const session = await createCliAgent({ config, log, now: clock, run }).open({});
    await session.send("hi");

    expect(records).toEqual([
      { durationMs: 240, event: "agent_probe", provider: "qwen", status: "ok" },
      { durationMs: 750, event: "agent_turn", provider: "qwen", status: "ok" }
    ]);
  });

  it("logs a failed turn under its failure code", async () => {
    const { log, records } = createLog();
    const { run } = createScriptedRunner([probeStdout(), { kind: "timeout" }]);

    const session = await createCliAgent({ config, log, run }).open({});
    await session.send("hi").catch(() => undefined);

    expect(records[1]?.status).toBe("agent_timeout");
    expect(records[1]?.event).toBe("agent_turn");
  });

  it("logs a failed probe under a neutral provider identifier", async () => {
    const { log, records } = createLog();
    const { run } = createScriptedRunner([{ exitCode: 1, kind: "failed", stderr: "boom" }]);

    await probeCliAgent({ config, log, run }).catch(() => undefined);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "agent_probe",
      provider: unknownProviderIdentifier,
      status: "agent_probe_failed"
    });
    expect(records[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("never logs prompt text, response text, or environment values", async () => {
    const { log, records } = createLog();
    const { run } = createScriptedRunner([
      probeStdout(),
      turnStdout({ text: "private-response-text" })
    ]);

    const session = await createCliAgent({ config, log, run }).open({
      instructions: "private-instructions"
    });
    await session.send("private-prompt-text");

    const logged = JSON.stringify(records);
    expect(logged).not.toContain("private-prompt-text");
    expect(logged).not.toContain("private-response-text");
    expect(logged).not.toContain("private-instructions");
    expect(logged).not.toContain(config.binaryPath);
    expect(logged).not.toContain(config.modelIdentifier);
  });
});
