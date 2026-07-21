#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// This module lives in scripts/delivery/; the operator launchers stay in scripts/.
const deliveryDir = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(deliveryDir, "..");
const repoRoot = resolve(deliveryDir, "..", "..");
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

export function runSupervisorCycle(role, runtime) {
  const launcher = resolve(scriptsDir, launchers[role]);
  const command = runtime.platform === "win32" ? (runtime.comSpec ?? "cmd.exe") : launcher;
  const args = runtime.platform === "win32" ? ["/d", "/c", launcher] : [];
  const result = runtime.spawn(command, args, {
    cwd: repoRoot,
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

export function waitForNextCycle(milliseconds) {
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

export async function runSupervisor(argv, runtime) {
  const { role, intervalSeconds } = parseSupervisorArgs(argv);
  runtime.log(
    `Delivery supervisor: ${role}; fresh one-shot workers; poll=${intervalSeconds}s; Ctrl+C stops.`
  );

  while (true) {
    const result = runSupervisorCycle(role, runtime);
    if (!result.ok) {
      runtime.error(
        `Delivery supervisor: ${role} worker failed with exit ${result.status}. ` +
          `The loop stopped to avoid an expensive retry. Resolve the reported failure, run ` +
          `\`${result.resumeCommand}\` once to resume the current unit, then restart this supervisor.`
      );
      return result.status;
    }

    if (!(await runtime.wait(intervalSeconds * 1_000))) {
      runtime.log(`Delivery supervisor: ${role} stopped.`);
      return 0;
    }
  }
}

export async function runCli(argv, runtime, processRef) {
  try {
    processRef.exitCode = await runSupervisor(argv, runtime);
  } catch (error) {
    runtime.error(`supervisor: ${error.message}`);
    processRef.exitCode = 1;
  }
}

export async function runIfMain(metaUrl, argv1, start) {
  if (metaUrl === pathToFileURL(argv1).href) await start();
}

const runtime = {
  comSpec: process.env.ComSpec,
  error: console.error,
  log: console.log,
  platform: process.platform,
  spawn: spawnSync,
  wait: waitForNextCycle
};

await runIfMain(
  import.meta.url,
  String(process.argv[1]),
  runCli.bind(null, process.argv.slice(2), runtime, process)
);
