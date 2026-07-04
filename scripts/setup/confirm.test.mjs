import { describe, expect, it } from "vitest";

import { makeConfirm } from "./confirm.mjs";

describe("makeConfirm", () => {
  it("returns true without prompting when pre-consented (--yes)", () => {
    let prompted = false;
    const confirm = makeConfirm({
      yes: true,
      isTTY: false,
      prompt: () => {
        prompted = true;
        return "n";
      }
    });
    expect(confirm("Install X now? [Y/n]")).toBe(true);
    expect(prompted).toBe(false);
  });

  it("declines without prompting when not a TTY (safe non-interactive default)", () => {
    let prompted = false;
    const confirm = makeConfirm({
      yes: false,
      isTTY: false,
      prompt: () => {
        prompted = true;
        return "y";
      }
    });
    expect(confirm("Install X now? [Y/n]")).toBe(false);
    expect(prompted).toBe(false);
  });

  it("treats empty / y / yes (any case, padded) as consent on a TTY", () => {
    for (const answer of ["", "  ", "y", "Y", "yes", "YES", " Yes "]) {
      const confirm = makeConfirm({ yes: false, isTTY: true, prompt: () => answer });
      expect(confirm("Install X now? [Y/n]")).toBe(true);
    }
  });

  it("treats n / no / anything else as decline on a TTY", () => {
    for (const answer of ["n", "N", "no", "NO", "nope", "maybe", "0"]) {
      const confirm = makeConfirm({ yes: false, isTTY: true, prompt: () => answer });
      expect(confirm("Install X now? [Y/n]")).toBe(false);
    }
  });

  it("declines when the prompt reports no interactive input (EOF / closed stdin returns null)", () => {
    // Guards the boundary bug where a redirected/closed stdin (null line) mapped to the empty-line
    // default and auto-consented: a null read must DECLINE, so `pnpm setup:voice < NUL` never installs.
    const confirm = makeConfirm({ yes: false, isTTY: true, prompt: () => null });
    expect(confirm("Install X now? [Y/n]")).toBe(false);
  });

  it("forwards the question to the injected prompt", () => {
    let seen = "";
    const confirm = makeConfirm({
      yes: false,
      isTTY: true,
      prompt: (question) => {
        seen = question;
        return "y";
      }
    });
    confirm("Install Python 3 now? [Y/n]");
    expect(seen).toBe("Install Python 3 now? [Y/n]");
  });
});
