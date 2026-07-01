// Shared test scaffolding for the setup framework: a fake `SetupContext` and small step factories
// so the runner and steps are exercised with zero real I/O. Excluded from coverage (test-only).

/**
 * @param {object} [overrides]
 * @returns {{ ctx: import("./step.mjs").SetupContext, logs: string[], execCalls: string[][], copies: Array<[string, string]> }}
 */
export function createFakeContext(overrides = {}) {
  const logs = [];
  /** @type {string[][]} */
  const execCalls = [];
  /** @type {Array<[string, string]>} */
  const copies = [];
  const files = new Set(overrides.files ?? []);
  const execResults = overrides.execResults ?? {};

  const ctx = {
    root: overrides.root ?? "/repo",
    platform: overrides.platform ?? "linux",
    env: overrides.env ?? {},
    exec(command, args) {
      execCalls.push([command, ...args]);
      const key = [command, ...args].join(" ");
      const result = execResults[key] ?? execResults[command] ?? overrides.defaultExec;
      return result ?? { code: 0, stdout: "", stderr: "" };
    },
    fs: {
      exists: (path) => files.has(path),
      copyFile: (from, to) => {
        copies.push([from, to]);
        files.add(to);
      }
    },
    log: (message) => logs.push(message)
  };
  return { ctx, logs, execCalls, copies, files };
}

/**
 * Build a fake step whose phases return queued results and record their calls.
 *
 * @param {object} config
 * @returns {{ step: import("./step.mjs").Step, calls: string[] }}
 */
export function createFakeStep(config) {
  const calls = [];
  const make = (phase, value) =>
    value === undefined
      ? undefined
      : () => {
          calls.push(phase);
          if (typeof value === "function") {
            return value();
          }
          return value;
        };

  const step = {
    id: config.id ?? "fake",
    title: config.title ?? "Fake step",
    optional: config.optional,
    capability: config.capability,
    check: make("check", config.check ?? { status: "ok" }),
    provision: make("provision", config.provision),
    verify: make("verify", config.verify)
  };
  return { step, calls };
}
