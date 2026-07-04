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

  it("5. installs and returns ok when consent is granted and the install makes check resolve", () => {
    // check is authoritative on every platform: the probe fails until the install runs, and the
    // post-install re-probe (no PATH refresh off win32) proves the tool now resolves.
    let installed = false;
    const { ctx, confirmCalls, execCalls, logs, refreshPathCalls } = createFakeContext({
      platform: "darwin",
      confirm: true,
      execHandler: (command, args) => {
        if (command === "widget") return { code: installed ? 0 : 1, stdout: "", stderr: "" };
        if (command === "brew" && args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
        if (command === "brew" && args[0] === "install") {
          installed = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
    });
    expect(installSystemTool(ctx, makeSpec())).toEqual({ status: "ok" });
    expect(confirmCalls).toEqual(["Install Widget now? [Y/n]"]);
    expect(execCalls).toContainEqual(["brew", "install", "widget"]);
    // The post-install re-probe ran (twice total: initial check + post-install check), no PATH refresh.
    expect(execCalls.filter((call) => call[0] === "widget").length).toBe(2);
    expect(refreshPathCalls()).toBe(0);
    expect(logs.join("\n")).toContain("installing Widget via brew");
  });

  it("honors a custom consent question, what text, and detect args", () => {
    let installed = false;
    const { ctx, confirmCalls, execCalls } = createFakeContext({
      platform: "win32",
      confirm: true,
      execHandler: (command, args) => {
        if (command === "widget") return { code: installed ? 0 : 1, stdout: "", stderr: "" };
        if (command === "winget" && args.join(" ") === "-v") return { code: 0, stdout: "", stderr: "" };
        if (command === "winget" && args[0] === "install") {
          installed = true;
          return { code: 0, stdout: "", stderr: "" };
        }
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

  it("win32: refreshes PATH before the initial check so an already-installed tool off the stale process PATH is detected — no prompt, no install (#429)", () => {
    // The tool is on the persisted (registry) PATH but not this stale shell's process PATH: the probe
    // fails until refreshPath re-reads PATH, after which it resolves. It must be detected up front,
    // with no consent prompt and no winget invocation.
    let onPath = false;
    const { ctx, confirmCalls, execCalls, refreshPathCalls } = createFakeContext({
      platform: "win32",
      onRefreshPath: () => {
        onPath = true;
      },
      execHandler: (command, args) =>
        command === "widget" && args[0] === "--probe"
          ? { code: onPath ? 0 : 1, stdout: "", stderr: "" }
          : undefined
    });
    expect(installSystemTool(ctx, makeSpec())).toEqual({ status: "ok" });
    expect(refreshPathCalls()).toBe(1);
    expect(confirmCalls).toEqual([]);
    // Only the check probe ran — no `winget --version` detect, no `winget install`.
    expect(execCalls).toEqual([["widget", "--probe"]]);
  });

  it("win32: a benign non-zero winget exit whose tool nonetheless resolves is ok (#429 — exit code is only a hint)", () => {
    // winget "already installed, no upgrade applicable" exits NON-ZERO (0x8A15002B), but the tool is
    // actually present. Readiness is decided by `check` after a PATH refresh, not by the exit code.
    let installed = false;
    const { ctx, refreshPathCalls, execCalls } = createFakeContext({
      platform: "win32",
      confirm: true,
      execHandler: (command, args) => {
        if (command === "widget") return { code: installed ? 0 : 1, stdout: "", stderr: "" };
        if (command === "winget" && args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
        if (command === "winget" && args[0] === "install") {
          installed = true;
          return { code: 1, stdout: "already installed", stderr: "no upgrade applicable" };
        }
        return { code: 1, stdout: "", stderr: "" };
      }
    });
    expect(installSystemTool(ctx, makeSpec())).toEqual({ status: "ok" });
    // Two refreshes: before the initial check (still missing), and after install (now resolves).
    expect(refreshPathCalls()).toBe(2);
    expect(execCalls).toContainEqual(["winget", "install", "Widget.Widget"]);
  });

  it("non-win32: returns error with the output tail when the install command exits non-zero", () => {
    const { ctx, refreshPathCalls } = createFakeContext({
      platform: "darwin",
      confirm: true,
      execHandler: (command, args) => {
        if (command === "widget") return { code: 1, stdout: "", stderr: "" };
        if (command === "brew" && args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
        if (command === "brew" && args[0] === "install") {
          return { code: 1, stdout: "", stderr: "brew: download failed" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
    });
    const result = installSystemTool(ctx, makeSpec());
    expect(result.status).toBe("error");
    expect(result.remedy).toContain("Install Widget manually.");
    expect(result.remedy).toContain("brew: download failed");
    expect(result.docs).toBe(DOCS);
    expect(refreshPathCalls()).toBe(0);
  });

  it("win32: refreshes PATH after a successful install so the tool re-resolves in the same run (#423)", () => {
    // Model the #423 scenario: winget installs the tool, but it is invisible to the running process
    // until PATH is refreshed. The probe fails until the install runs; the post-install refresh +
    // re-probe resolves it in the same run (no new terminal needed).
    let installed = false;
    const { ctx, refreshPathCalls, execCalls } = createFakeContext({
      platform: "win32",
      confirm: true,
      execHandler: (command, args) => {
        if (command === "widget") return { code: installed ? 0 : 1, stdout: "", stderr: "" };
        if (command === "winget" && args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
        if (command === "winget" && args[0] === "install") {
          installed = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "" };
      }
    });
    expect(installSystemTool(ctx, makeSpec())).toEqual({ status: "ok" });
    expect(refreshPathCalls()).toBe(2); // initial (still missing) + post-install (resolves)
    // The re-probe (post-refresh) proves install->use completed without opening a new terminal.
    expect(execCalls).toContainEqual(["widget", "--probe"]);
  });

  it("win32: names the stale-PATH cause when the installed tool still does not resolve (#423)", () => {
    // Install succeeds, PATH refresh runs, but the tool is still unresolved on this process's PATH
    // (e.g. an installer that only updates a fresh shell's environment). The remedy must name the
    // real cause — a stale terminal PATH — not any downstream/daemon hint.
    const { ctx, refreshPathCalls } = createFakeContext({
      platform: "win32",
      confirm: true,
      execHandler: (command, args) => {
        if (command === "widget") return { code: 1, stdout: "", stderr: "" }; // never resolves
        if (command === "winget" && args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
        if (command === "winget" && args[0] === "install") return { code: 0, stdout: "", stderr: "" };
        return { code: 1, stdout: "", stderr: "" };
      }
    });
    const result = installSystemTool(ctx, makeSpec());
    expect(result.status).toBe("missing");
    expect(result.what).toContain("was installed but is not on this terminal's PATH");
    expect(result.remedy).toContain("Open a new terminal");
    expect(result.remedy).toContain("Widget");
    expect(refreshPathCalls()).toBe(2); // initial (still missing) + post-install (still unresolved)
  });

  it("does not refresh PATH on non-win32 platforms after a successful install", () => {
    let installed = false;
    const { ctx, refreshPathCalls } = createFakeContext({
      platform: "darwin",
      confirm: true,
      execHandler: (command, args) => {
        if (command === "widget") return { code: installed ? 0 : 1, stdout: "", stderr: "" };
        if (command === "brew" && args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
        if (command === "brew" && args[0] === "install") {
          installed = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
    });
    expect(installSystemTool(ctx, makeSpec())).toEqual({ status: "ok" });
    expect(refreshPathCalls()).toBe(0);
  });

  it("non-win32: an exit-zero install whose tool still does not resolve is the stale-PATH missing, not ok (#429 review — check is authoritative on every platform)", () => {
    // check re-runs on every platform: a brew install that exits 0 but leaves the tool unresolved
    // must NOT be reported ok. An exit-zero-still-missing is a stale-shell situation → `missing`
    // (open a new terminal), the same contract as win32, and with no PATH refresh off win32.
    const { ctx, execCalls, refreshPathCalls } = createFakeContext({
      platform: "darwin",
      confirm: true,
      execHandler: (command, args) => {
        if (command === "widget") return { code: 1, stdout: "", stderr: "" }; // never resolves
        if (command === "brew" && args[0] === "--version") return { code: 0, stdout: "", stderr: "" };
        if (command === "brew" && args[0] === "install") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }
    });
    const result = installSystemTool(ctx, makeSpec());
    expect(result.status).toBe("missing");
    expect(result.what).toContain("was installed but is not on this terminal's PATH");
    expect(result.remedy).toContain("Open a new terminal");
    // The post-install re-probe ran (initial check + post-install check), no PATH refresh off win32.
    expect(execCalls.filter((call) => call[0] === "widget").length).toBe(2);
    expect(refreshPathCalls()).toBe(0);
  });
});
