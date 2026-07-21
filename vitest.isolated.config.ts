import { defineConfig } from "vitest/config";

import { sourceAliases } from "./vitest.config";

export default defineConfig({
  resolve: {
    alias: sourceAliases
  },
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 30000,
    include: [
      "scripts/setup/setupScriptRouting.test.mjs",
      "src/apps/server/src/data/backupRestore.test.ts"
    ],
    maxWorkers: 1,
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 120000
  }
});
