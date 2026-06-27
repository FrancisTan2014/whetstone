import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const domainSource = fileURLToPath(new URL("./src/packages/domain/src/index.ts", import.meta.url));
const contractsSource = fileURLToPath(new URL("./src/packages/contracts/src/index.ts", import.meta.url));

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
        "**/src/db/migrate.ts", // Migration bootstrap is wiring-only infrastructure.
        "**/src/db/migrations/**",
        "**/src/db/schema.ts", // Drizzle table declarations are exercised through migrations and integration tests.
        "**/src/index.ts",
        "**/src/mcp/main.ts", // MCP stdio bootstrap is wiring-only infrastructure (like index.ts).
        "**/src/main.tsx",
        // Browser MediaRecorder boundary for mic capture: touches navigator/MediaRecorder/real timers,
        // not exercisable in jsdom; the session page injects a fake, and the STT/submit logic is covered.
        "**/features/session/audioCapture.ts",
        "**/src/**/*.type.ts",
        "**/src/**/*.types.ts",
        // Pure presentational design-token modules: static enum->class/style/motion maps, no logic.
        "**/src/**/*.tokens.ts",
        "**/src/**/*.tokens.tsx",
        "**/src/vite-env.d.ts"
      ],
      include: ["src/apps/*/src/**/*.{ts,tsx}", "src/packages/*/src/**/*.{ts,tsx}"],
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
    // PGlite integration tests boot a fresh in-process Postgres (WASM) and run every migration per
    // case; in isolation that is ~2s, but under the full suite's parallel load it can exceed Vitest's
    // 5s default and flake. A generous timeout keeps these real-database tests reliable without
    // weakening any assertion or coverage threshold.
    hookTimeout: 30000,
    include: ["src/apps/**/*.{test,spec}.{ts,tsx}", "src/packages/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 30000
  }
});
