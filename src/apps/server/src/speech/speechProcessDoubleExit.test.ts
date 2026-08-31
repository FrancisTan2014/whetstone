import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

// This suite lives apart from `speechProcess.test.ts` (which exercises `spawnPersistentProcess` against
// a real child process) because it needs `node:child_process`'s `spawn` mocked to deterministically
// fabricate a specific, hard-to-reproduce-for-real event sequence: Node's documented contract is that a
// child emits EITHER 'error' (failed to spawn) OR 'exit' (spawned then ended), never both, and every real
// spawn attempted here (a real missing binary, a real killed process, a real double-kill) only ever
// fires one - see the sibling suite. The guard below exists specifically for the rare edge case where a
// child does emit both, so it is proven here against a fake, controllable child instead.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const { spawn } = await import("node:child_process");
const { spawnPersistentProcess } = await import("./speechProcess.js");

class FakeChild extends EventEmitter {
  kill = vi.fn();
  stdin = { write: vi.fn() };
  stdout: null = null;
}

describe("spawnPersistentProcess - double-exit guard", () => {
  it("calls onExit only once even if the underlying child emits both 'exit' and 'error'", () => {
    const fakeChild = new FakeChild();
    vi.mocked(spawn).mockReturnValue(fakeChild as never);

    let exits = 0;
    spawnPersistentProcess(
      "binary",
      [],
      () => {},
      () => {
        exits += 1;
      }
    );

    fakeChild.emit("exit", 1, null);
    fakeChild.emit("error", new Error("a stray error event after the process already exited"));

    expect(exits).toBe(1);
  });
});
