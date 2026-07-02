import { describe, expect, it } from "vitest";

import { installSystemTool } from "./installSystemTool.mjs";
import { missing, ok } from "./step.mjs";
import { createFakeContext } from "./testSupport.mjs";

const DOCS = "https://example.test/install";

/**
 * A spec whose readiness `check` is driven by the fake exec: `tool --probe` exit 0 = present.
 * Platform install plans cover win32 (winget) and darwin (brew); linux is intentionally omitted so
 * the "no package manager for this platform" path is reachable.
 */
function makeSpec(overrides = {}) {
  return {
    name: "Widget",
    check: (ctx) =>
      ctx.exec("widget", ["--probe"]).code === 0
        ? ok()
        : missing("Widget is required but was not found.", "Install Widget manually."),
    remedy: "Install Widget manually.",
    docs: DOCS,
    plans: {
      win32: { manager: "winget", args: ["install", "Widget.Widget"] },
      darwin: { manager: "brew", args: ["install", "widget"] }
    },
    ...overrides
  };
}

describe("installSystemTool", () => {
  it("1. returns ok without prompting or installing when check is already ok", () => {
    const { ctx, confirmCalls, execCalls } = createFakeContext({
      platform: "win32",
      execHandler: (command, args) =>
        command === "widget" && args[0] === "--probe" ? { code: 0, stdout: "", stderr: "" } : undefined
    });
    expect(installSystemTool(ctx, makeSpec())).toEqual({ status: "ok" });
    expect(confirmCalls).toEqual([]);
    expect(execCalls).toEqual([["widget", "--probe"]]);
  });

  it("2. returns instruct-only missing (with docs) when the platform has no package manager plan", () => {
    const { ctx, confirmCalls } = createFakeContext({
      platform: "linux", // no plan for linux
      execHandler: () => ({ code: 1, stdout: "", stderr: "" })
    });
    const result = installSystemTool(ctx, makeSpec());
    expect(result).toEqual({
      status: "missing",
      what: "Widget is required but was not found.",
      remedy: "Install Widget manually.",
      docs: DOCS
    });
    expect(confirmCalls).toEqual([]);
  });

  it("2. returns instruct-only missing when the platform's package manager is absent", () => {
    const { ctx, confirmCalls } = createFakeContext({
      platform: "win32",
      // winget --version fails => manager absent; check probe also fails.
      execHandler: () => ({ code: 1, stdout: "", stderr: "" })
    });
    const result = installSystemTool(ctx, makeSpec());
    expect(result.status).toBe("missing");
    expect(result.docs).toBe(DOCS);
    expect(confirmCalls).toEqual([]);
  });

  it("3. returns instruct-only missing (no docs) when consent is declined", () => {
    const { ctx, confirmCalls } = createFakeContext({
      platform: "darwin",
      confirm: false,
      execHandler: (command, args) => {
        if (command === "widget") return { code: 1, stdout: "", stderr: "" }; // not present
        if (command === "brew" && args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }
    });
    const result = installSystemTool(ctx, makeSpec());
    expect(result).toEqual({
      status: "missing",
      what: "Widget is required but was not found.",
      remedy: "Install Widget manually."
    });
    expect(result.docs).toBeUndefined();
    expect(confirmCalls).toEqual(["Install Widget now? [Y/n]"]);
  });

  it("4. returns error with the output tail when the install command exits non-zero", () => {
    const { ctx } = createFakeContext({
      platform: "win32",
      confirm: true,
      execHandler: (command, args) => {
        if (command === "widget") return { code: 1, stdout: "", stderr: "" };
        if (command === "winget" && args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
        if (command === "winget" && args[0] === "install") {
          return { code: 1, stdout: "", stderr: "winget: download blocked" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
    });
    const result = installSystemTool(ctx, makeSpec());
    expect(result.status).toBe("error");
    expect(result.what).toBe("Widget is required but was not found.");
    expect(result.remedy).toContain("Install Widget manually.");
    expect(result.remedy).toContain("winget: download blocked");
    expect(result.docs).toBe(DOCS);
  });

  it("5. installs and returns ok when consent is granted and the install succeeds", () => {
    const { ctx, confirmCalls, execCalls, logs } = createFakeContext({
      platform: "darwin",
      confirm: true,
      execHandler: (command, args) => {
        if (command === "widget") return { code: 1, stdout: "", stderr: "" };
        if (command === "brew" && args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
        if (command === "brew" && args[0] === "install") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }
    });
    expect(installSystemTool(ctx, makeSpec())).toEqual({ status: "ok" });
    expect(confirmCalls).toEqual(["Install Widget now? [Y/n]"]);
    expect(execCalls).toContainEqual(["brew", "install", "widget"]);
    expect(logs.join("\n")).toContain("installing Widget via brew");
  });

  it("honors a custom consent question, what text, and detect args", () => {
    const { ctx, confirmCalls, execCalls } = createFakeContext({
      platform: "win32",
      confirm: true,
      execHandler: (command, args) => {
        if (command === "widget") return { code: 1, stdout: "", stderr: "" };
        if (command === "winget" && args.join(" ") === "-v") return { code: 0, stdout: "", stderr: "" };
        if (command === "winget" && args[0] === "install") return { code: 0, stdout: "", stderr: "" };
        return { code: 1, stdout: "", stderr: "" };
      }
    });
    const spec = makeSpec({
      question: "Set up Widget? [Y/n]",
      what: "Widget missing.",
      plans: { win32: { manager: "winget", args: ["install", "W"], detect: ["-v"] } }
    });
    expect(installSystemTool(ctx, spec)).toEqual({ status: "ok" });
    expect(confirmCalls).toEqual(["Set up Widget? [Y/n]"]);
    expect(execCalls).toContainEqual(["winget", "-v"]);
  });
});
