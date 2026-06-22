import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const domainSource = fileURLToPath(new URL("./packages/domain/src/index.ts", import.meta.url));
const contractsSource = fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@whetstone/domain": domainSource,
      "@whetstone/contracts": contractsSource
    }
  },
  test: {
    coverage: {
      all: true,
      exclude: [
        "**/*.d.ts",
        "**/*.test.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        "**/src/config/**",
        "**/src/index.ts",
        "**/src/main.tsx",
        "**/src/**/*.type.ts",
        "**/src/**/*.types.ts",
        "**/src/vite-env.d.ts"
      ],
      include: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
      provider: "v8",
      reporter: ["text", "json", "html"],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    },
    environment: "node",
    include: ["apps/**/*.{test,spec}.{ts,tsx}", "packages/**/*.{test,spec}.{ts,tsx}"]
  }
});
