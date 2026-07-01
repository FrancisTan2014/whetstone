import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// A Vitest config scoped to the two packages under mutation (issue #349). Stryker's dry run and every
// per-mutant run use this, so they execute ONLY the pure domain + contracts tests — not the whole
// suite (whose PGlite server tests are slow and would time out the initial run). It carries the same
// @whetstone/* aliases as the root config so those packages resolve from source, and omits coverage
// (Stryker does its own per-test coverage analysis).
const domainSource = fileURLToPath(new URL("./src/packages/domain/src/index.ts", import.meta.url));
const contractsSource = fileURLToPath(
  new URL("./src/packages/contracts/src/index.ts", import.meta.url)
);
const documentSource = fileURLToPath(
  new URL("./src/packages/document/src/index.ts", import.meta.url)
);

export default defineConfig({
  resolve: {
    alias: {
      "@whetstone/contracts": contractsSource,
      "@whetstone/document": documentSource,
      "@whetstone/domain": domainSource
    }
  },
  test: {
    environment: "node",
    include: [
      "src/packages/domain/**/*.{test,spec}.ts",
      "src/packages/contracts/**/*.{test,spec}.ts"
    ]
  }
});
