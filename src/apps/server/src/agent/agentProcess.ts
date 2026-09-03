import { spawn } from "node:child_process";

// The OS-process boundary for the local agent seam (#904), injected into the adapter exactly as
// `speechProcess.ts` injects its `CommandRunner`: the protocol logic stays testable against a fake
// while this thin runner is itself exercised end-to-end against a real child process.
//
// It differs from the speech runner in one deliberate way: the prompt is written to the child's
// **stdin**, which is then closed, instead of being passed as an argv parameter. Agent prompts are long
// and multi-line, and argv has hard length limits and quoting hazards (notably on Windows), so stdin is
// the only safe channel for them. That is why this uses `spawn` rather than `execFile`.

// One agent invocation: the configured executable, its protocol arguments, the payload written to stdin
// (then closed), and the wall-clock bound after which the child is terminated.
export type AgentCommand = Readonly<{
  args: ReadonlyArray<string>;
  binaryPath: string;
  stdin: string;
  timeoutMs: number;
}>;

// Every way an invocation can end, as data rather than an exception, so the adapter maps outcomes to
// its own named failures in one place and no caller has to inspect an error string. A child that never
// started (a missing or unrunnable executable) is normalized to `failed` carrying the OS message.
export type AgentCommandOutcome =
  | Readonly<{ kind: "ok"; stdout: string }>
  | Readonly<{ kind: "failed"; exitCode: number | null; stderr: string }>
  | Readonly<{ kind: "timeout" }>;

export type AgentCommandRunner = (command: AgentCommand) => Promise<AgentCommandOutcome>;

// How much stdout/stderr one invocation may retain. A local agent CLI is untrusted output: without a
// cap, a runaway provider could stream until the server runs out of memory. No real turn approaches
// 1 MiB of JSON, and a truncated response simply fails contract validation by name rather than being
// partially trusted.
const maxCapturedChars = 1024 * 1024;

function appendCapped(current: string, chunk: string): string {
  return current.length >= maxCapturedChars
    ? current
    : `${current}${chunk}`.slice(0, maxCapturedChars);
}

export const spawnAgentCommand: AgentCommandRunner = ({ args, binaryPath, stdin, timeoutMs }) =>
  new Promise((resolve) => {
    const child = spawn(binaryPath, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    // The child can reach an end state more than once (a timeout kill is followed by the real exit; a
    // failed spawn can be followed by a close), so every path funnels through one guarded settle and
    // the run resolves exactly once.
    const settle = (outcome: AgentCommandOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      child.kill();
      settle({ kind: "timeout" });
    }, timeoutMs);

    if (child.stdout !== null) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = appendCapped(stdout, chunk);
      });
    }
    if (child.stderr !== null) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = appendCapped(stderr, chunk);
      });
    }
    if (child.stdin !== null) {
      // A provider that exits before reading the whole prompt makes this write fail with EPIPE. The
      // run's real outcome already arrives through 'error'/'close', so the stream error is
      // acknowledged and dropped here rather than crashing the server with an unhandled 'error' event.
      child.stdin.on("error", () => {});
      child.stdin.write(stdin);
      child.stdin.end();
    }

    // A spawn failure (e.g. a missing binary) surfaces as an 'error' event with no exit code; it is the
    // same thing to a caller as a provider that ran and failed, so it maps to the same outcome.
    child.on("error", (error: Error) => {
      settle({ exitCode: null, kind: "failed", stderr: error.message });
    });
    // 'close' rather than 'exit': it fires once stdout/stderr are fully drained, so the captured output
    // is complete.
    child.on("close", (code: number | null) => {
      settle(code === 0 ? { kind: "ok", stdout } : { exitCode: code, kind: "failed", stderr });
    });
  });
