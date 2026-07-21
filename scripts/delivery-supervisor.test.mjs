import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  parseSupervisorArgs,
  runCli,
  runIfMain,
  runSupervisor,
  runSupervisorCycle,
  waitForNextCycle
} from "./delivery-supervisor.mjs";

function runtime(overrides = {}) {
  return {
    comSpec: undefined,
    error() {},
    log() {},
    platform: "linux",
    spawn() {
      return { status: 0 };
    },
    async wait() {
      return false;
    },
    ...overrides
  };
}

test("supervisor accepts only a known role and positive interval", () => {
  assert.deepEqual(parseSupervisorArgs(["developer"]), {
    role: "developer",
    intervalSeconds: 120
  });
  assert.deepEqual(parseSupervisorArgs(["reviewer", "--interval", "30"]), {
    role: "reviewer",
    intervalSeconds: 30
  });
  assert.throws(() => parseSupervisorArgs(["tester"]), /developer.*reviewer/);
  assert.throws(() => parseSupervisorArgs(["developer", "--interval", "0"]), /positive integer/);
  assert.throws(() => parseSupervisorArgs(["developer", "--interval"]), /positive integer/);
  assert.throws(
    () => parseSupervisorArgs(["developer", "--interval", "later"]),
    /positive integer/
  );
});

test("supervisor cycle preserves foreground execution on every platform", () => {
  const invocations = [];
  const linux = runSupervisorCycle(
    "developer",
    runtime({
      spawn(command, args, options) {
        invocations.push({ command, args, options });
        return { status: 0 };
      }
    })
  );
  assert.equal(linux.ok, true);
  assert.deepEqual(invocations[0].args, []);
  assert.equal(invocations[0].options.stdio, "inherit");
  assert.match(invocations[0].command, /run-developer\.cmd$/);

  const windows = runSupervisorCycle(
    "reviewer",
    runtime({
      comSpec: "custom-cmd.exe",
      platform: "win32",
      spawn(command, args, options) {
        invocations.push({ command, args, options });
        return { status: 7 };
      }
    })
  );
  assert.deepEqual(
    {
      command: invocations[1].command,
      args: invocations[1].args,
      ok: windows.ok,
      status: windows.status,
      resumeCommand: windows.resumeCommand
    },
    {
      command: "custom-cmd.exe",
      args: ["/d", "/c", resolve("scripts/run-reviewer.cmd")],
      ok: false,
      status: 7,
      resumeCommand: ".\\scripts\\run-reviewer.cmd"
    }
  );

  const spawnError = new Error("cannot start");
  const missingStatus = runSupervisorCycle(
    "developer",
    runtime({
      platform: "win32",
      spawn() {
        return { status: null, error: spawnError };
      }
    })
  );
  assert.equal(missingStatus.status, 1);
  assert.equal(missingStatus.error, spawnError);
});

test("wait resolves for both the timer and Ctrl+C", async () => {
  assert.equal(await waitForNextCycle(0), true);

  const interrupted = waitForNextCycle(1_000);
  process.emit("SIGINT");
  assert.equal(await interrupted, false);
});

test("supervisor continues after success, stops cleanly, and stops on failure", async () => {
  const logs = [];
  let cycles = 0;
  let waits = 0;
  const stopped = await runSupervisor(
    ["developer", "--interval", "3"],
    runtime({
      log(message) {
        logs.push(message);
      },
      spawn() {
        cycles++;
        return { status: 0 };
      },
      async wait(milliseconds) {
        assert.equal(milliseconds, 3_000);
        waits++;
        return waits === 1;
      }
    })
  );
  assert.equal(stopped, 0);
  assert.equal(cycles, 2);
  assert.match(logs.join("\n"), /fresh one-shot workers.*stopped/s);

  const errors = [];
  const failed = await runSupervisor(
    ["reviewer"],
    runtime({
      error(message) {
        errors.push(message);
      },
      spawn() {
        return { status: 9 };
      }
    })
  );
  assert.equal(failed, 9);
  assert.match(errors[0], /run-reviewer\.cmd.*restart this supervisor/);
});

test("CLI reports configuration errors and runIfMain starts only the entry module", async () => {
  const errors = [];
  const failedProcess = {};
  await runCli(
    ["unknown"],
    runtime({
      error(message) {
        errors.push(message);
      }
    }),
    failedProcess
  );
  assert.equal(failedProcess.exitCode, 1);
  assert.match(errors[0], /role must be/);

  const workerProcess = {};
  await runCli(
    ["developer"],
    runtime({
      spawn() {
        return { status: 4 };
      }
    }),
    workerProcess
  );
  assert.equal(workerProcess.exitCode, 4);

  const modulePath = resolve("scripts/delivery-supervisor.mjs");
  const moduleUrl = pathToFileURL(modulePath).href;
  let starts = 0;
  await runIfMain(moduleUrl, resolve("scripts/not-the-supervisor.mjs"), async () => {
    starts++;
  });
  await runIfMain(moduleUrl, modulePath, async () => {
    starts++;
  });
  assert.equal(starts, 1);
});
