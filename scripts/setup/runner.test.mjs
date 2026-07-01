import { describe, expect, it } from "vitest";

import {
  formatSummary,
  parseArgs,
  runSetup,
  selectSteps
} from "./runner.mjs";
import { createFakeContext, createFakeStep } from "./testSupport.mjs";

describe("parseArgs", () => {
  it("defaults to no flags", () => {
    expect(parseArgs([])).toEqual({ doctor: false, voice: false, coach: false, unknown: [] });
  });

  it("maps --check and --doctor to doctor mode", () => {
    expect(parseArgs(["--check"]).doctor).toBe(true);
    expect(parseArgs(["--doctor"]).doctor).toBe(true);
  });

  it("recognizes opt-in capability flags, order-independent", () => {
    expect(parseArgs(["--coach", "--voice"])).toEqual({
      doctor: false,
      voice: true,
      coach: true,
      unknown: []
    });
  });

  it("collects unrecognized flags", () => {
    expect(parseArgs(["--voice", "--nope", "-x"]).unknown).toEqual(["--nope", "-x"]);
  });
});

describe("selectSteps", () => {
  const base = createFakeStep({ id: "base" }).step;
  const voice = createFakeStep({ id: "voice", optional: true, capability: "voice" }).step;
  const coach = createFakeStep({ id: "coach", optional: true, capability: "coach" }).step;
  const optionalNoCapability = createFakeStep({ id: "loose", optional: true }).step;
  const steps = [base, voice, coach, optionalNoCapability];

  it("includes only base steps with no flags", () => {
    expect(selectSteps(steps, { voice: false, coach: false })).toEqual([base]);
  });

  it("adds the matching optional capability when its flag is set", () => {
    expect(selectSteps(steps, { voice: true, coach: false })).toEqual([base, voice]);
    expect(selectSteps(steps, { voice: false, coach: true })).toEqual([base, coach]);
  });

  it("adds both when both flags are set", () => {
    expect(selectSteps(steps, { voice: true, coach: true })).toEqual([base, voice, coach]);
  });
});

describe("runSetup — happy and resumable paths", () => {
  it("skips provision when check is already ok (idempotent/resumable)", () => {
    const { step, calls } = createFakeStep({ check: { status: "ok" }, provision: { status: "ok" } });
    const { ctx } = createFakeContext();
    const { exitCode, outcomes } = runSetup([step], ctx);

    expect(exitCode).toBe(0);
    expect(calls).toEqual(["check"]);
    expect(outcomes[0].result).toEqual({ status: "ok" });
  });

  it("provisions then verifies when check is not ok", () => {
    const { step, calls } = createFakeStep({
      check: { status: "missing", what: "gone", remedy: "add it" },
      provision: { status: "ok" },
      verify: { status: "ok" }
    });
    const { ctx } = createFakeContext();
    const { exitCode } = runSetup([step], ctx);

    expect(exitCode).toBe(0);
    expect(calls).toEqual(["check", "provision", "verify"]);
  });

  it("falls back to check when a step has no verify", () => {
    let checks = 0;
    const { step } = createFakeStep({
      id: "novrf",
      check: () => {
        checks += 1;
        return checks === 1 ? { status: "missing", what: "x", remedy: "y" } : { status: "ok" };
      },
      provision: { status: "ok" }
    });
    const { ctx } = createFakeContext();
    expect(runSetup([step], ctx).exitCode).toBe(0);
    expect(checks).toBe(2);
  });
});

describe("runSetup — failure policy", () => {
  it("aborts on a required failure and marks later steps not-run", () => {
    const failing = createFakeStep({
      id: "req",
      check: { status: "missing", what: "gone", remedy: "add it" }
    });
    const later = createFakeStep({ id: "later" });
    const { ctx, logs } = createFakeContext();
    const { exitCode, outcomes } = runSetup([failing.step, later.step], ctx);

    expect(exitCode).toBe(1);
    expect(outcomes[1]).toMatchObject({ skipped: true, result: null });
    expect(later.calls).toEqual([]);
    expect(logs.join("\n")).toContain('required step "Fake step" failed; stopping');
  });

  it("continues past an optional failure and stays green", () => {
    const optional = createFakeStep({
      id: "opt",
      optional: true,
      check: { status: "error", what: "flaky", remedy: "later" }
    });
    const after = createFakeStep({ id: "after" });
    const { ctx, logs } = createFakeContext();
    const { exitCode, outcomes } = runSetup([optional.step, after.step], ctx);

    expect(exitCode).toBe(0);
    expect(outcomes[1].result).toEqual({ status: "ok" });
    expect(after.calls).toContain("check");
    expect(logs.join("\n")).toContain('optional step "Fake step" not ready');
  });

  it("maps a provision() throw to an actionable error, not a raw stack", () => {
    const { step } = createFakeStep({
      id: "throws",
      check: { status: "missing", what: "x", remedy: "y" },
      provision: () => {
        throw new Error("network down");
      }
    });
    const { ctx } = createFakeContext();
    const { exitCode, outcomes } = runSetup([step], ctx);

    expect(exitCode).toBe(1);
    expect(outcomes[0].result).toMatchObject({ status: "error" });
    expect(outcomes[0].result.what).toContain("threw during provision");
    expect(outcomes[0].result.remedy).toContain("network down");
  });

  it("maps a non-Error throw to a string remedy", () => {
    const { step } = createFakeStep({
      id: "throws2",
      check: () => {
        throw "raw string boom";
      }
    });
    const { ctx } = createFakeContext();
    const { outcomes } = runSetup([step], ctx);
    expect(outcomes[0].result.remedy).toContain("raw string boom");
  });

  it("does not verify when provision returns error", () => {
    const { step, calls } = createFakeStep({
      id: "provfail",
      check: { status: "missing", what: "x", remedy: "y" },
      provision: { status: "error", what: "failed", remedy: "retry" },
      verify: { status: "ok" }
    });
    const { ctx } = createFakeContext();
    const { exitCode, outcomes } = runSetup([step], ctx);

    expect(exitCode).toBe(1);
    expect(calls).toEqual(["check", "provision"]);
    expect(outcomes[0].result).toMatchObject({ status: "error", what: "failed" });
  });

  it("treats a missing status (invalid result) as error", () => {
    const { step } = createFakeStep({ id: "bad", check: () => ({ notAStatus: true }) });
    const { ctx } = createFakeContext();
    const { outcomes } = runSetup([step], ctx);
    expect(outcomes[0].result).toMatchObject({ status: "error" });
    expect(outcomes[0].result.what).toContain("returned no status");
  });

  it("reports a required instruct-only step (no provision) without mutating", () => {
    const { step, calls } = createFakeStep({
      id: "toolchain",
      check: { status: "missing", what: "Node too old", remedy: "upgrade" }
    });
    const { ctx } = createFakeContext();
    const { exitCode, outcomes } = runSetup([step], ctx);

    expect(exitCode).toBe(1);
    expect(calls).toEqual(["check"]);
    expect(outcomes[0].result).toMatchObject({ what: "Node too old" });
  });
});

describe("runSetup — doctor mode", () => {
  it("runs only check(), never provision/verify, and never aborts", () => {
    const first = createFakeStep({
      id: "a",
      check: { status: "missing", what: "gone", remedy: "add" },
      provision: { status: "ok" }
    });
    const second = createFakeStep({ id: "b", check: { status: "ok" } });
    const { ctx } = createFakeContext();
    const { exitCode, outcomes } = runSetup([first.step, second.step], ctx, { doctor: true });

    expect(exitCode).toBe(1); // a required step is missing
    expect(first.calls).toEqual(["check"]);
    expect(second.calls).toEqual(["check"]);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[1].result).toEqual({ status: "ok" });
  });

  it("exits 0 when only an optional step is missing", () => {
    const optional = createFakeStep({
      id: "opt",
      optional: true,
      check: { status: "missing", what: "no voice", remedy: "pass --voice" }
    });
    const { ctx } = createFakeContext();
    expect(runSetup([optional.step], ctx, { doctor: true }).exitCode).toBe(0);
  });

  it("exits 0 when everything is ready", () => {
    const { step } = createFakeStep({ check: { status: "ok" } });
    const { ctx } = createFakeContext();
    expect(runSetup([step], ctx, { doctor: true }).exitCode).toBe(0);
  });
});

describe("formatSummary", () => {
  const okOutcome = { step: createFakeStep({ title: "Deps" }).step, result: { status: "ok" }, skipped: false };
  const requiredFail = {
    step: createFakeStep({ title: "Build" }).step,
    result: { status: "error", what: "compile failed", remedy: "run pnpm install\nthen pnpm build", docs: "https://d" },
    skipped: false
  };
  const optionalMiss = {
    step: createFakeStep({ title: "Voice", optional: true }).step,
    result: { status: "missing", what: "no model", remedy: "pass --voice" },
    skipped: false
  };
  const skipped = { step: createFakeStep({ title: "Env" }).step, result: null, skipped: true };

  it("renders each outcome kind with its guidance", () => {
    const text = formatSummary([okOutcome, requiredFail, optionalMiss, skipped], { exitCode: 1 });
    expect(text).toContain("[ ok ] Deps — ready.");
    expect(text).toContain("[FAIL] Build");
    expect(text).toContain("what: compile failed");
    expect(text).toContain("fix:  run pnpm install");
    expect(text).toContain("docs: https://d");
    expect(text).toContain("[MISS] Voice (optional)");
    expect(text).toContain("[skip] Env — not run");
  });

  it("indents a multi-line remedy under the fix label", () => {
    const text = formatSummary([requiredFail], { exitCode: 1 });
    expect(text).toContain("fix:  run pnpm install\n               then pnpm build");
  });

  it("uses the setup success footer when the run passed", () => {
    const text = formatSummary([okOutcome], { exitCode: 0 });
    expect(text).toContain("Setup complete. Next: run `pnpm dev`.");
  });

  it("uses the setup failure footer when the run stopped", () => {
    const text = formatSummary([requiredFail], { exitCode: 1 });
    expect(text).toContain("re-run `pnpm setup`");
  });

  it("uses the doctor success footer", () => {
    const text = formatSummary([okOutcome], { doctor: true, exitCode: 0 });
    expect(text).toContain("All required capabilities are ready. Next: run `pnpm dev`.");
  });

  it("uses the doctor failure footer", () => {
    const text = formatSummary([requiredFail], { doctor: true, exitCode: 1 });
    expect(text).toContain("required capabilities are missing");
    expect(text).toContain("Setup doctor — capability readiness:");
  });

  it("omits optional detail lines when the result has none", () => {
    const bare = { step: createFakeStep({ title: "Bare" }).step, result: { status: "missing" }, skipped: false };
    const text = formatSummary([bare], { exitCode: 1 });
    expect(text).toContain("[MISS] Bare");
    expect(text).not.toContain("what:");
  });
});
