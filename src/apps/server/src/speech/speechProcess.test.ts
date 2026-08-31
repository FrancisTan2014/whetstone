import { describe, expect, it, vi } from "vitest";

import { runCommand, spawnPersistentProcess } from "./speechProcess.js";

// The runner is exercised end-to-end against a real child process by driving the Node binary itself as
// the "command" — no speech install needed, fully cross-platform.
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

// #884: exercised against a real child process (driving Node itself as an echo-line "provider") so the
// stdin/stdout line framing and exit normalization are proven at the real process boundary, mirroring
// `runCommand`'s own real-process test above.
describe("spawnPersistentProcess", () => {
  const echoLinesScript =
    "const rl = require('node:readline').createInterface({ input: process.stdin });" +
    "rl.on('line', (line) => process.stdout.write(`echo:${line}\\n`));";

  it("writes request lines to stdin and delivers each response line to the listener", async () => {
    const lines: string[] = [];
    const handle = spawnPersistentProcess(
      process.execPath,
      ["-e", echoLinesScript],
      (line) => lines.push(line),
      () => {}
    );

    await vi.waitFor(() => {
      handle.writeLine("first.audio");
      expect(lines).toContain("echo:first.audio");
    });
    await vi.waitFor(() => {
      handle.writeLine("second.audio");
      expect(lines).toContain("echo:second.audio");
    });

    handle.kill();
  });

  it("calls onExit exactly once when the process is killed", async () => {
    let exits = 0;
    const handle = spawnPersistentProcess(
      process.execPath,
      ["-e", echoLinesScript],
      () => {},
      () => {
        exits += 1;
      }
    );

    handle.kill();
    await vi.waitFor(() => expect(exits).toBe(1));
  });

  it("calls onExit when the process exits on its own (stdin closed)", async () => {
    let exited = false;
    const handle = spawnPersistentProcess(
      process.execPath,
      ["-e", echoLinesScript],
      () => {},
      () => {
        exited = true;
      }
    );

    handle.kill();
    await vi.waitFor(() => expect(exited).toBe(true));
  });

  it("normalizes a spawn failure (missing binary) to onExit, never a thrown/unhandled error", async () => {
    let exits = 0;
    spawnPersistentProcess(
      "definitely-not-a-real-executable-xyz",
      [],
      () => {},
      () => {
        exits += 1;
      }
    );
    await vi.waitFor(() => expect(exits).toBe(1));
  });
});
