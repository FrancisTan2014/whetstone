import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildPersistentModeArgs,
  createPersistentSpeechManager,
  IDLE_UNLOAD_MS,
  type PersistentSpeechManagerConfig
} from "./persistentSpeechManager.js";
import { spawnPersistentProcess, type PersistentProcessLauncher } from "./speechProcess.js";

const CONFIG: PersistentSpeechManagerConfig = Object.freeze({
  binaryPath: "/opt/fake/whetstone-qwen",
  modelIdentifier: "Qwen/Qwen3-ASR-1.7B"
});

// A controllable fake launcher (mirroring the seam `CommandRunner` already uses elsewhere): each launch
// call is recorded with the exact callbacks the manager wired to it, so a test can resolve/crash/inspect
// a specific launch instance directly rather than guessing at internal timing.
type FakeLaunch = Readonly<{
  args: ReadonlyArray<string>;
  kill: ReturnType<typeof vi.fn>;
  onExit: () => void;
  onLine: (line: string) => void;
  writeLine: ReturnType<typeof vi.fn>;
}>;

function createFakeLauncher(): { launch: PersistentProcessLauncher; launches: FakeLaunch[] } {
  const launches: FakeLaunch[] = [];
  const launch: PersistentProcessLauncher = (_binaryPath, args, onLine, onExit) => {
    const writeLine = vi.fn();
    const kill = vi.fn();
    launches.push({ args, kill, onExit, onLine, writeLine });
    return Object.freeze({ kill, writeLine });
  };
  return { launch, launches };
}

describe("buildPersistentModeArgs", () => {
  it("passes only the model identifier - no audio positional (each request arrives later, per line)", () => {
    expect(buildPersistentModeArgs(CONFIG)).toEqual([
      "--persistent",
      "--model",
      CONFIG.modelIdentifier
    ]);
  });
});

describe("createPersistentSpeechManager", () => {
  it("spawns lazily: no launch happens until the first transcribe() call", () => {
    const { launch, launches } = createFakeLauncher();
    createPersistentSpeechManager({ config: CONFIG, launch });
    expect(launches).toHaveLength(0);
  });

  it("uses the real process launcher by default", async () => {
    const manager = createPersistentSpeechManager({
      config: { binaryPath: process.execPath, modelIdentifier: "unused" }
    });
    try {
      // Node rejects the persistent-mode args, exercising the default launcher end-to-end: the process
      // exits immediately rather than serving the line protocol, which the manager surfaces as a crash.
      await expect(manager.transcribe("a.wav")).rejects.toThrow(/exited unexpectedly/);
    } finally {
      manager.close();
    }
  });

  it("reuses the same warm process across back-to-back captures", async () => {
    const { launch, launches } = createFakeLauncher();
    const manager = createPersistentSpeechManager({ config: CONFIG, launch });

    const first = manager.transcribe("first.wav");
    expect(launches).toHaveLength(1);
    launches[0]!.onLine('{"text":"first"}');
    await expect(first).resolves.toBe('{"text":"first"}');

    const second = manager.transcribe("second.wav");
    expect(launches).toHaveLength(1); // still just the one process
    expect(launches[0]!.writeLine).toHaveBeenNthCalledWith(2, "second.wav");
    launches[0]!.onLine('{"text":"second"}');
    await expect(second).resolves.toBe('{"text":"second"}');
  });

  it("rejects a second concurrent request without touching the process (single-flight guard, #565)", async () => {
    const { launch, launches } = createFakeLauncher();
    const manager = createPersistentSpeechManager({ config: CONFIG, launch });

    const first = manager.transcribe("first.wav");
    await expect(manager.transcribe("second.wav")).rejects.toThrow(/already handling a request/);
    expect(launches[0]!.writeLine).toHaveBeenCalledTimes(1);

    launches[0]!.onLine('{"text":"first"}');
    await expect(first).resolves.toBe('{"text":"first"}');
  });

  it("rejects the in-flight capture and respawns transparently after a mid-request crash", async () => {
    const { launch, launches } = createFakeLauncher();
    const manager = createPersistentSpeechManager({ config: CONFIG, launch });

    const first = manager.transcribe("first.wav");
    launches[0]!.onExit(); // simulate the process dying before it answered
    await expect(first).rejects.toThrow(/exited unexpectedly/);

    const second = manager.transcribe("second.wav");
    expect(launches).toHaveLength(2); // respawned
    launches[1]!.onLine('{"text":"second"}');
    await expect(second).resolves.toBe('{"text":"second"}');
  });

  it("ignores a stray response line that arrives from an already-retired (crashed) process", async () => {
    const { launch, launches } = createFakeLauncher();
    const manager = createPersistentSpeechManager({ config: CONFIG, launch });

    const first = manager.transcribe("first.wav");
    launches[0]!.onExit(); // crash retires generation 0 and rejects the in-flight request
    await expect(first).rejects.toThrow(/exited unexpectedly/);

    const second = manager.transcribe("second.wav");
    expect(launches).toHaveLength(2); // respawned onto generation 1

    // A late response line from the dead generation-0 process must never resolve/interfere with the
    // CURRENT (generation-1) request - if it did, `second` would resolve to this stray text instead of
    // whatever the live, generation-1 process later answers.
    launches[0]!.onLine('{"text":"stray"}');
    launches[1]!.onLine('{"text":"second"}');
    await expect(second).resolves.toBe('{"text":"second"}');
  });

  it("ignores a late exit event that arrives after idle-unload has already retired the process", async () => {
    vi.useFakeTimers();
    try {
      const { launch, launches } = createFakeLauncher();
      const manager = createPersistentSpeechManager({ config: CONFIG, launch });

      const first = manager.transcribe("first.wav");
      launches[0]!.onLine('{"text":"first"}');
      await first;

      // The idle window elapses: the manager kills the process and retires its generation
      // synchronously, without waiting for the real (asynchronous) OS exit event.
      vi.advanceTimersByTime(IDLE_UNLOAD_MS);
      expect(launches[0]!.kill).toHaveBeenCalledTimes(1);

      // The real process's exit event arrives late, well after retirement. It must be silently ignored
      // - never rejecting some unrelated future request or retiring an already-fresh process again.
      launches[0]!.onExit();

      const second = manager.transcribe("second.wav");
      expect(launches).toHaveLength(2); // respawned once, by the idle-unload path, not by the late exit
      launches[1]!.onLine('{"text":"second"}');
      await expect(second).resolves.toBe('{"text":"second"}');
    } finally {
      vi.useRealTimers();
    }
  });

  describe("idle-unload (fixed 5-minute sliding window, #884)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("kills the process after the full idle window with no further captures", async () => {
      const { launch, launches } = createFakeLauncher();
      const manager = createPersistentSpeechManager({ config: CONFIG, launch });

      const first = manager.transcribe("first.wav");
      launches[0]!.onLine('{"text":"first"}');
      await first;

      vi.advanceTimersByTime(IDLE_UNLOAD_MS - 1);
      expect(launches[0]!.kill).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(launches[0]!.kill).toHaveBeenCalledTimes(1);
    });

    it("slides the window forward on every completed capture", async () => {
      const { launch, launches } = createFakeLauncher();
      const manager = createPersistentSpeechManager({ config: CONFIG, launch });

      const first = manager.transcribe("first.wav");
      launches[0]!.onLine('{"text":"first"}');
      await first;

      vi.advanceTimersByTime(IDLE_UNLOAD_MS / 2);
      expect(launches[0]!.kill).not.toHaveBeenCalled();

      const second = manager.transcribe("second.wav");
      launches[0]!.onLine('{"text":"second"}');
      await second;

      // Only half the window has elapsed since the SECOND capture completed - must still be alive even
      // though the full window has elapsed since the first.
      vi.advanceTimersByTime(IDLE_UNLOAD_MS / 2);
      expect(launches[0]!.kill).not.toHaveBeenCalled();

      vi.advanceTimersByTime(IDLE_UNLOAD_MS / 2);
      expect(launches[0]!.kill).toHaveBeenCalledTimes(1);
    });

    it("respawns on the next capture after an idle-unload, paying cold start again", async () => {
      const { launch, launches } = createFakeLauncher();
      const manager = createPersistentSpeechManager({ config: CONFIG, launch });

      const first = manager.transcribe("first.wav");
      launches[0]!.onLine('{"text":"first"}');
      await first;

      vi.advanceTimersByTime(IDLE_UNLOAD_MS);
      expect(launches[0]!.kill).toHaveBeenCalledTimes(1);

      const second = manager.transcribe("second.wav");
      expect(launches).toHaveLength(2);
      launches[1]!.onLine('{"text":"second"}');
      await expect(second).resolves.toBe('{"text":"second"}');
    });
  });

  describe("close()", () => {
    it("is a no-op when no process has ever been started", () => {
      const { launch, launches } = createFakeLauncher();
      const manager = createPersistentSpeechManager({ config: CONFIG, launch });
      expect(() => manager.close()).not.toThrow();
      expect(launches).toHaveLength(0);
    });

    it("kills the active process and cancels its idle timer", async () => {
      vi.useFakeTimers();
      try {
        const { launch, launches } = createFakeLauncher();
        const manager = createPersistentSpeechManager({ config: CONFIG, launch });

        const first = manager.transcribe("first.wav");
        launches[0]!.onLine('{"text":"first"}');
        await first;

        manager.close();
        expect(launches[0]!.kill).toHaveBeenCalledTimes(1);

        // A stray idle-unload firing after close() must never double-kill an already-retired process.
        vi.advanceTimersByTime(IDLE_UNLOAD_MS);
        expect(launches[0]!.kill).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// #884: a process-level test against the REAL `spawnPersistentProcess` launcher (no fake), driving a
// small standalone Node fixture script that answers the transcript contract and reports a running
// request counter, so two close-together transcriptions proving the SAME warm process served both -
// never a fresh spawn per request - is demonstrated against the real OS-process boundary, mirroring the
// Python wrapper's own real-process persistent-mode test.
describe("createPersistentSpeechManager (real process fixture)", () => {
  it("serves two requests from one real warm process without reloading", async () => {
    const fixtureScript =
      "let requests = 0;" +
      "require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {" +
      "requests += 1;" +
      "process.stdout.write(JSON.stringify({ text: line, requests }) + '\\n');" +
      "});";

    const launch: PersistentProcessLauncher = (binaryPath, _args, onLine, onExit) =>
      spawnPersistentProcess(binaryPath, ["-e", fixtureScript], onLine, onExit);

    const manager = createPersistentSpeechManager({
      config: { binaryPath: process.execPath, modelIdentifier: "unused" },
      launch
    });

    try {
      const first = JSON.parse(await manager.transcribe("first.wav")) as {
        requests: number;
        text: string;
      };
      expect(first).toEqual({ requests: 1, text: "first.wav" });

      const second = JSON.parse(await manager.transcribe("second.wav")) as {
        requests: number;
        text: string;
      };
      expect(second).toEqual({ requests: 2, text: "second.wav" });
    } finally {
      manager.close();
    }
  });
});
