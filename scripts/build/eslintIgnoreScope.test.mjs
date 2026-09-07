import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

// The standing guard for #917: ESLint walked the gitignored `.data/` runtime directory and linted
// vendored third-party JavaScript shipped inside the managed Python venvs (pip's bundled urllib3
// emscripten worker), so `pnpm lint` -- and therefore `pnpm validate` / `pnpm validate:changed` --
// could not pass on any machine that had run `pnpm setup:voice` or `pnpm setup:ai`. The fix adds
// `**/.data/**` to the `ignores` in eslint.config.js.
//
// This is exactly the class of bug that is invisible in CI: CI runs from a clean checkout where
// `.data/` does not exist, so nothing upstream can catch a regression here. `isPathIgnored` answers
// purely from the resolved config and needs no file on disk, so it reproduces the defect and guards
// the fix on every machine, `.data/` present or not. A config edit alone can be silently reverted;
// this recomputes the truth from ESLint itself rather than reading the config text.
//
// Why a native `node` child: `new ESLint()` resolves the flat config by dynamically importing
// eslint.config.js, whose dependency graph (typescript-eslint) is pulled through Vitest's module
// transform when the ESLint API runs in-process in this lane -- a one-time cost large enough to trip
// the test timeout. A plain `node` child resolves the *real* eslint.config.js natively in ~3s, so
// this stays faithful (the actual resolved config, not a copy) without slowing the quality lane.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// The exact file from the #917 repro, deeply nested inside a managed venv.
const reproFile =
  ".data/whisper-venv/Lib/site-packages/pip/_vendor/urllib3/contrib/emscripten/emscripten_fetch_worker.js";

// Deeply nested, shallow, and other `.data/` subtrees (managed venvs, imported images, PDF staging)
// are all machine-local runtime state, never source we lint.
const ignoredPaths = [
  reproFile,
  ".data/copilot-venv/x.js",
  ".data/images/anything.mjs",
  ".data/x.ts"
];

// The ignore must not swallow real source. `eslint.config.js` and `vitest.config.ts` are linted, and
// crucially the ignore targets the dotted `.data/` runtime dir, not the tracked
// `src/apps/server/src/data/` feature directory -- an easy `.data` -> `data` slip this pins down.
const lintedPaths = [
  "eslint.config.js",
  "vitest.config.ts",
  "src/apps/server/src/data/dataRoots.ts"
];

// Resolve `isPathIgnored` for every path against the real eslint.config.js, in one native child.
function resolveIgnored(paths) {
  const probe = `(async () => {
    const { ESLint } = require("eslint");
    const eslint = new ESLint();
    const paths = ${JSON.stringify(paths)};
    const result = {};
    for (const p of paths) result[p] = await eslint.isPathIgnored(p);
    process.stdout.write(JSON.stringify(result));
  })();`;
  // Spawn under a sanitized environment: the quality lane enables Vitest's v8 coverage, which sets
  // NODE_OPTIONS / NODE_V8_COVERAGE on this process. Inherited by the child, those re-attach the
  // instrumentation this child exists to escape, making native config resolution slow enough to
  // trip the hook timeout. Drop them so the child is a plain, fast `node`.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_V8_COVERAGE;
  const output = execFileSync(process.execPath, ["-e", probe], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });
  return JSON.parse(output);
}

describe("eslint ignore scope (#917)", () => {
  let ignored;
  // The child resolves the real flat config (~3s); allow generous margin for a loaded CI runner.
  beforeAll(() => {
    ignored = resolveIgnored([...ignoredPaths, ...lintedPaths]);
  }, 60000);

  it("ignores the gitignored .data/ runtime directory at any depth", () => {
    for (const path of ignoredPaths) {
      expect(ignored[path], path).toBe(true);
    }
  });

  it("still lints real tracked source outside .data/", () => {
    for (const path of lintedPaths) {
      expect(ignored[path], path).toBe(false);
    }
  });
});
