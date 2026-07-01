// Base step 1 — toolchain preflight. System prerequisites are **checked and instructed, never
// force-installed** (policy/safety): Node and pnpm gate the run with an actionable remedy; Python
// is reported as a hint only (a future voice/coach consumer needs it, the base app does not), so a
// missing Python never fails this required step.

import { missing, ok } from "../step.mjs";

const MIN_NODE_MAJOR = 22;

/**
 * @param {string} versionOutput  e.g. "v22.3.0".
 * @returns {number}  Major version, or NaN when unparseable.
 */
export function parseNodeMajor(versionOutput) {
  const match = /v?(\d+)\./.exec(versionOutput.trim());
  return match ? Number(match[1]) : Number.NaN;
}

/** @type {import("../step.mjs").Step} */
export const toolchainStep = {
  id: "toolchain",
  title: "Toolchain (Node, pnpm, Python)",
  check(ctx) {
    const node = ctx.exec("node", ["-v"]);
    const major = parseNodeMajor(node.stdout);
    if (node.code !== 0 || Number.isNaN(major)) {
      return missing(
        "Could not determine the Node.js version.",
        "Install Node.js 22 or newer from https://nodejs.org, then re-run.",
        "https://nodejs.org"
      );
    }
    if (major < MIN_NODE_MAJOR) {
      return missing(
        `Node.js ${major} is too old; whetstone needs >= ${MIN_NODE_MAJOR}.`,
        `Upgrade Node.js to ${MIN_NODE_MAJOR}+ (https://nodejs.org) and re-run.`,
        "https://nodejs.org"
      );
    }

    const pnpm = ctx.exec("pnpm", ["-v"]);
    if (pnpm.code !== 0) {
      return missing(
        "pnpm is not available on PATH.",
        "Enable it via Corepack (ships with Node): run `corepack enable`, then re-run.",
        "https://pnpm.io/installation"
      );
    }

    const python = ctx.exec("python", ["--version"]);
    if (python.code !== 0) {
      const python3 = ctx.exec("python3", ["--version"]);
      if (python3.code !== 0) {
        ctx.log(
          "[setup] hint: Python was not found. The base app does not need it, but the optional " +
            "voice/coach steps do — install Python 3 (https://www.python.org/downloads) when you enable them."
        );
      }
    }

    return ok();
  }
};
