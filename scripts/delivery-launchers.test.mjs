import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

test(
  "Windows one-shot launchers propagate selector failures",
  { skip: process.platform !== "win32" },
  () => {
    const testDir = mkdtempSync(join(tmpdir(), "whetstone-launcher-test-"));
    try {
      const failingSelector = join(testDir, "fail-selector.cmd");
      writeFileSync(failingSelector, "@echo off\r\necho selector failed 1>&2\r\nexit /b 7\r\n");
      for (const launcher of ["run-developer.cmd", "run-reviewer.cmd"]) {
        const result = spawnSync(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/c", resolve("scripts", launcher)],
          {
            cwd: resolve("."),
            encoding: "utf8",
            env: {
              ...process.env,
              WHETSTONE_SELECTOR_COMMAND: failingSelector
            }
          }
        );
        assert.equal(result.status, 7, `${launcher}\n${result.stdout}\n${result.stderr}`);
        assert.match(result.stderr, /selector failed/);
      }
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  }
);
