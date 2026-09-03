import { describe, expect, it } from "vitest";

import { spawnAgentCommand } from "./agentProcess.js";

// The runner is exercised end-to-end against a real child process by driving the Node binary itself as
// the "agent" - no agent CLI is installed, needed, or spawned, and it is fully cross-platform.
const readStdinScript =
  "let input = '';" +
  "process.stdin.on('data', (chunk) => { input += chunk; });" +
  "process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), text: input })); });";

describe("spawnAgentCommand", () => {
  it("writes the prompt to stdin, closes it, and resolves with the child's stdout", async () => {
    const outcome = await spawnAgentCommand({
      // `--` ends Node's own option parsing, so `--model m` reaches the script exactly as a provider
      // would receive the protocol's arguments.
      args: ["-e", readStdinScript, "--", "--model", "m"],
      binaryPath: process.execPath,
      stdin: "a long\nmulti-line prompt",
      timeoutMs: 30_000
    });

    expect(outcome.kind).toBe("ok");
    // Reaching 'end' at all proves stdin was closed after the write; the echoed argv proves the
    // protocol arguments arrive as separate argv entries with no shell quoting in between.
    expect(outcome.kind === "ok" ? JSON.parse(outcome.stdout) : undefined).toEqual({
      argv: ["--model", "m"],
      text: "a long\nmulti-line prompt"
    });
  });

  it("reports a non-zero exit as a failure carrying the child's stderr", async () => {
    const outcome = await spawnAgentCommand({
      args: ["-e", "process.stderr.write('provider blew up'); process.exit(3);"],
      binaryPath: process.execPath,
      stdin: "",
      timeoutMs: 30_000
    });

    expect(outcome).toEqual({ exitCode: 3, kind: "failed", stderr: "provider blew up" });
  });

  it("normalizes a missing executable to the same failure outcome, never a thrown error", async () => {
    const outcome = await spawnAgentCommand({
      args: [],
      binaryPath: "definitely-not-a-real-agent-executable-xyz",
      stdin: "prompt",
      timeoutMs: 30_000
    });

    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" ? outcome.exitCode : 0).toBeNull();
    expect(outcome.kind === "failed" ? outcome.stderr : "").not.toHaveLength(0);
  });

  it("terminates a provider that outlives its wall-clock bound and reports a timeout", async () => {
    const outcome = await spawnAgentCommand({
      args: ["-e", "setTimeout(() => {}, 60_000);"],
      binaryPath: process.execPath,
      stdin: "",
      timeoutMs: 100
    });

    expect(outcome).toEqual({ kind: "timeout" });
  });
});
