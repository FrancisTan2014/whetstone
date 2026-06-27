import { describe, expect, it } from "vitest";

import { runCommand } from "./whisperProcess.js";

// The runner is exercised end-to-end against a real child process by driving the Node binary itself as
// the "command" — no Whisper install needed, fully cross-platform.
describe("runCommand", () => {
  it("resolves with the command's stdout", async () => {
    const stdout = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write('hello-stdout')"
    ]);
    expect(stdout).toBe("hello-stdout");
  });

  it("rejects when the command exits non-zero", async () => {
    await expect(runCommand(process.execPath, ["-e", "process.exit(3)"])).rejects.toThrow();
  });
});
