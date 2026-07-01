import { describe, expect, it } from "vitest";

import { error, isOk, missing, ok, withOutputTail } from "./step.mjs";

describe("step result helpers", () => {
  it("ok() has no advisory fields", () => {
    expect(ok()).toEqual({ status: "ok" });
  });

  it("missing() carries what/remedy and optional docs", () => {
    expect(missing("gone", "install it")).toEqual({
      status: "missing",
      what: "gone",
      remedy: "install it"
    });
    expect(missing("gone", "install it", "https://docs")).toEqual({
      status: "missing",
      what: "gone",
      remedy: "install it",
      docs: "https://docs"
    });
  });

  it("error() carries what/remedy and optional docs", () => {
    expect(error("boom", "retry")).toEqual({ status: "error", what: "boom", remedy: "retry" });
    expect(error("boom", "retry", "https://docs")).toEqual({
      status: "error",
      what: "boom",
      remedy: "retry",
      docs: "https://docs"
    });
  });

  it("isOk() distinguishes ok from non-ok", () => {
    expect(isOk(ok())).toBe(true);
    expect(isOk(missing("a", "b"))).toBe(false);
    expect(isOk(error("a", "b"))).toBe(false);
  });
});

describe("withOutputTail", () => {
  it("returns the remedy unchanged when there is no output", () => {
    expect(withOutputTail("fix it", { code: 1, stdout: "", stderr: "  \n " })).toBe("fix it");
  });

  it("appends a trimmed tail of the combined output", () => {
    const result = withOutputTail("fix it", { code: 1, stdout: "out-line", stderr: "err-line" });
    expect(result).toContain("fix it");
    expect(result).toContain("Last output:");
    expect(result).toContain("out-line");
    expect(result).toContain("err-line");
  });

  it("keeps only the last N lines", () => {
    const stdout = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
    const result = withOutputTail("fix", { code: 1, stdout, stderr: "" }, 3);
    expect(result).toContain("line-19");
    expect(result).not.toContain("line-15");
  });

  it("tolerates missing stdout/stderr", () => {
    expect(withOutputTail("fix", /** @type {any} */ ({ code: 1 }))).toBe("fix");
  });
});
