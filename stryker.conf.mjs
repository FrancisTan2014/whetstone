// Advisory mutation testing (issue #349) — automates the GUIDELINES mutation-resistance gate for the
// two pure, logic-dense, fast packages (@whetstone/domain, @whetstone/contracts). It surfaces shallow
// / happy-path-only tests that still hit 100% line coverage but do not actually assert behavior.
//
// Deliberately ADVISORY: run via `pnpm mutation` (not `pnpm validate`) and nightly in CI. `break` is
// unset, so it never fails the merge gate; `low` is the achieved-baseline floor so regressions show.
// Server/web are out of scope for v0 (slower, I/O-bound) — extend `mutate` to add a package later.

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  // pnpm's symlinked node_modules defeats Stryker's default `@stryker-mutator/*` plugin glob, so name
  // the runner plugin explicitly.
  plugins: ["@stryker-mutator/vitest-runner"],
  // Only run the tests that cover each mutant — keeps runs tractable over the whole suite.
  coverageAnalysis: "perTest",
  // The Vitest runner uses a scoped config that runs ONLY the domain + contracts tests (the whole
  // suite's PGlite server tests are slow and time out Stryker's initial run). It carries the same
  // @whetstone/* aliases as the root vitest.config.ts.
  vitest: { configFile: "vitest.stryker.config.ts" },
  mutate: [
    "src/packages/domain/src/**/*.ts",
    "src/packages/contracts/src/**/*.ts",
    // Exclude tests, presentational token maps, type-only modules, and barrels (no logic to mutate).
    "!src/packages/*/src/**/*.test.ts",
    "!src/packages/*/src/**/*.tokens.ts",
    "!src/packages/*/src/**/*.type.ts",
    "!src/packages/*/src/**/*.types.ts",
    "!src/packages/*/src/index.ts"
  ],
  reporters: ["html", "json", "clear-text"],
  // Advisory floor only. `break` is intentionally omitted so the run never fails a gate; `low` is the
  // baseline achieved on domain + contracts (issue #349), so a drop below it is visible in the report.
  thresholds: { high: 90, low: 82 }
};
