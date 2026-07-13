// Regression for #421: `setup` is a built-in pnpm command, so `pnpm setup` with a capability flag
// (`--voice`/`--coach`/`--all`) routed to pnpm's built-in and died with `[ERROR] Unknown option` before the package script ran.
// The fix exposes each capability as a non-colliding `setup:<capability>` script. This guard invokes
// each of those scripts through pnpm — the real user entry point — and proves they reach our doctor
// (`--check`) run instead of pnpm's built-in. `--check` keeps every probe read-only, so the test is
// CI-safe (it never installs Python, Ollama, or a Whisper model).

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveCommand } from "./platform.mjs";

// scripts/setup/ -> repo root is two levels up.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pnpm = resolveCommand("pnpm", process.platform);

/**
 * Invoke a package script through pnpm's shorthand (`pnpm <script>`) — the exact form the docs tell
 * users to run — with `--check` so the run only probes and never mutates.
 *
 * @param {string} script
 * @returns {{ output: string, status: number | null }}
 */
function runShorthand(script) {
  // A single command string with `shell: true` (no args array) resolves pnpm's `.cmd` shim on
  // Windows and avoids Node's DEP0190 warning. Every token here is a fixed literal, not user input.
  const result = spawnSync(`${pnpm} ${script} --check`, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: true
  });
  return { output: `${result.stdout ?? ""}${result.stderr ?? ""}`, status: result.status };
}

describe("pnpm setup:<capability> scripts do not collide with pnpm's built-in `setup` (#421)", () => {
  for (const script of ["setup:minimal", "setup:voice", "setup:ai", "setup:pdf", "setup:all"]) {
    it(`\`pnpm ${script}\` reaches our doctor run, not pnpm's built-in setup`, () => {
      const { output } = runShorthand(script);
      // The reported failure: routing to the built-in rejects the baked-in flag as unknown.
      expect(output).not.toMatch(/Unknown option/i);
      // Proof the shorthand reached our script in read-only doctor mode (logs "checking", not
      // "running"), so no capability was actually installed.
      expect(output).toContain("[setup] checking:");
    });
  }

  it("`pnpm setup:coach` reaches our migration notice pointing at setup:ai, not an unknown-flag no-op (#602)", () => {
    const { output } = runShorthand("setup:coach");
    expect(output).not.toMatch(/Unknown option/i);
    // The retired coach flag prints the exact migration command and exits cleanly, rather than being
    // silently ignored as an unrecognized flag.
    expect(output).toContain("pnpm setup:ai");
    expect(output).not.toContain("[setup] checking:");
  });
});
