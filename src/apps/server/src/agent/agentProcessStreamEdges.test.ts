import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

// This suite lives apart from `agentProcess.test.ts` (which drives a real child process) because it
// needs `node:child_process`'s `spawn` mocked to fabricate stream and lifecycle edges a real local
// provider only produces under a race: a child with no stdio streams attached, an EPIPE on stdin from a
// provider that exited before reading the prompt, a child that both fails to spawn and closes, and a
// provider that floods stdout. Each is proven here against a fake, controllable child instead.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const { spawn } = await import("node:child_process");
const { spawnAgentCommand } = await import("./agentProcess.js");

// Matches `maxCapturedChars` in agentProcess.ts: the retained-output bound for one invocation.
const maxCapturedChars = 1024 * 1024;

class FakeStream extends EventEmitter {
  setEncoding = vi.fn();
  write = vi.fn();
  end = vi.fn();
}

class FakeChild extends EventEmitter {
  kill = vi.fn();
  stdin: FakeStream | null = new FakeStream();
  stdout: FakeStream | null = new FakeStream();
  stderr: FakeStream | null = new FakeStream();
}

function mockChild(child: FakeChild): void {
  vi.mocked(spawn).mockReturnValue(child as never);
}

function run(child: FakeChild): Promise<unknown> {
  mockChild(child);
  return spawnAgentCommand({
    args: [],
    binaryPath: "agent",
    stdin: "prompt",
    timeoutMs: 30_000
  });
}

describe("spawnAgentCommand - stream and lifecycle edges", () => {
  it("still settles when the child exposes no stdio streams at all", async () => {
    const child = new FakeChild();
    child.stdin = null;
    child.stdout = null;
    child.stderr = null;

    const outcome = run(child);
    child.emit("close", 0);

    await expect(outcome).resolves.toEqual({ kind: "ok", stdout: "" });
  });

  it("drops an EPIPE on stdin: the real outcome still arrives from the child", async () => {
    const child = new FakeChild();

    const outcome = run(child);
    child.stdin?.emit("error", new Error("EPIPE: the provider stopped reading the prompt"));
    child.emit("close", 0);

    await expect(outcome).resolves.toEqual({ kind: "ok", stdout: "" });
  });

  it("settles exactly once when the child both fails to spawn and then closes", async () => {
    const child = new FakeChild();

    const outcome = run(child);
    child.emit("error", new Error("spawn ENOENT"));
    child.emit("close", 1);

    await expect(outcome).resolves.toEqual({
      exitCode: null,
      kind: "failed",
      stderr: "spawn ENOENT"
    });
  });

  it("caps retained output so a flooding provider cannot exhaust memory", async () => {
    const child = new FakeChild();

    const outcome = run(child);
    child.stdout?.emit("data", "a".repeat(maxCapturedChars + 5));
    child.stdout?.emit("data", "b");
    child.emit("close", 0);

    const resolved = await outcome;
    const stdout = (resolved as { stdout: string }).stdout;
    expect(stdout).toHaveLength(maxCapturedChars);
    expect(stdout.includes("b")).toBe(false);
  });
});
