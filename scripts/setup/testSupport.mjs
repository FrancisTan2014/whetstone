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
  // Path -> UTF-8 content. Seed existence-only paths (from `files`) as empty strings, then apply any
  // explicit contents (from `fileContents`).
  const files = new Map((overrides.files ?? []).map((path) => [path, ""]));
  for (const [path, content] of Object.entries(overrides.fileContents ?? {})) {
    files.set(path, content);
  }
  const execResults = overrides.execResults ?? {};

  const ctx = {
    root: overrides.root ?? "/repo",
    platform: overrides.platform ?? "linux",
    env: overrides.env ?? {},
    exec(command, args) {
      execCalls.push([command, ...args]);
      if (overrides.execHandler) {
        const handled = overrides.execHandler(command, args);
        if (handled) {
          return handled;
        }
      }
      const key = [command, ...args].join(" ");
      const result = execResults[key] ?? execResults[command] ?? overrides.defaultExec;
      return result ?? { code: 0, stdout: "", stderr: "" };
    },
    fs: {
      exists: (path) => files.has(path),
      readText: (path) => {
        if (!files.has(path)) {
          throw new Error(`ENOENT: ${path}`);
        }
        return files.get(path);
      },
      writeText: (path, content) => files.set(path, content),
      copyFile: (from, to) => {
        copies.push([from, to]);
        files.set(to, files.get(from) ?? "");
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
