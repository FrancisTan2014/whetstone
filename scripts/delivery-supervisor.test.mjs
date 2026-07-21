import assert from "node:assert/strict";
import test from "node:test";

import { parseSupervisorArgs, runSupervisorCycle } from "./delivery-supervisor.mjs";

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
});

test("supervisor cycle preserves foreground execution and stops on child failure", () => {
  let invocation;
  const success = runSupervisorCycle("developer", (command, args, options) => {
    invocation = { command, args, options };
    return { status: 0 };
  });
  assert.equal(success.ok, true);
  assert.equal(invocation.options.stdio, "inherit");
  assert.match(invocation.args.at(-1) ?? invocation.command, /run-developer\.cmd$/);

  const failure = runSupervisorCycle("reviewer", () => ({ status: 7 }));
  assert.deepEqual(
    { ok: failure.ok, status: failure.status, resumeCommand: failure.resumeCommand },
    { ok: false, status: 7, resumeCommand: ".\\scripts\\run-reviewer.cmd" }
  );
});
