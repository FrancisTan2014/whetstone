#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const launchers = {
  developer: "run-developer.cmd",
  reviewer: "run-reviewer.cmd"
};

export function parseSupervisorArgs(argv) {
  const role = argv[0];
  if (!(role in launchers)) {
    throw new Error("role must be `developer` or `reviewer`");
  }
  const intervalIndex = argv.indexOf("--interval");
  const intervalSeconds =
    intervalIndex === -1 ? 120 : Number.parseInt(argv[intervalIndex + 1] ?? "", 10);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
    throw new Error("--interval must be a positive integer number of seconds");
  }
  return { role, intervalSeconds };
}

export function runSupervisorCycle(role, spawn = spawnSync) {
  const launcher = resolve(scriptsDir, launchers[role]);
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : launcher;
  const args = process.platform === "win32" ? ["/d", "/c", launcher] : [];
  const result = spawn(command, args, {
    cwd: resolve(scriptsDir, ".."),
    encoding: "utf8",
    stdio: "inherit"
  });

  const status = result.status ?? 1;
  return {
    ok: result.error == null && status === 0,
    status,
    error: result.error,
    resumeCommand: `.\\scripts\\${launchers[role]}`
  };
}

function waitForNextCycle(milliseconds) {
  return new Promise((resolveWait) => {
    const stop = () => {
      clearTimeout(timer);
      process.off("SIGINT", stop);
      resolveWait(false);
    };
    const timer = setTimeout(() => {
      process.off("SIGINT", stop);
      resolveWait(true);
    }, milliseconds);
    process.once("SIGINT", stop);
  });
}

async function run() {
  const { role, intervalSeconds } = parseSupervisorArgs(process.argv.slice(2));
  console.log(
    `Delivery supervisor: ${role}; fresh one-shot workers; poll=${intervalSeconds}s; Ctrl+C stops.`
  );

  while (true) {
    const result = runSupervisorCycle(role);
    if (!result.ok) {
      console.error(
        `Delivery supervisor: ${role} worker failed with exit ${result.status}. ` +
          `The loop stopped to avoid an expensive retry. Resolve the reported failure, run ` +
          `\`${result.resumeCommand}\` once to resume the current unit, then restart this supervisor.`
      );
      process.exitCode = result.status;
      return;
    }

    if (!(await waitForNextCycle(intervalSeconds * 1_000))) {
      console.log(`Delivery supervisor: ${role} stopped.`);
      return;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run().catch((error) => {
    console.error(`delivery-supervisor: ${error.message}`);
    process.exit(1);
  });
}
