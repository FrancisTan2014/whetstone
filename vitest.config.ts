import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

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
        // Real PGlite + argv bootstraps for `pnpm data:backup` / `pnpm data:restore`: wiring-only
        // I/O entrypoints (like index.ts); all decision logic lives in the covered data/*.ts modules.
        "**/src/data/backupCli.ts",
        "**/src/data/restoreCli.ts",
        // The setup runner's real-I/O boundary: builds the SetupContext from Node's
        // child_process/fs/os and is wiring-only (like src/**/index.ts). All setup decision logic
        // lives in scripts/setup/runner.mjs and the steps, covered via fakes.
        "scripts/setup/context.mjs",
        // Setup test files and their shared fake-context/step scaffolding (test-only, not shipped).
        "scripts/setup/**/*.{test,spec}.mjs",
        "scripts/setup/testSupport.mjs",
        "**/src/mcp/main.ts", // MCP stdio bootstrap is wiring-only infrastructure (like index.ts).
        "**/src/main.tsx",
        // Browser Web Audio / MediaRecorder boundary for voice-diary capture (#455/#565): touches
        // AudioContext/AnalyserNode/MediaRecorder/real timers, not exercisable in jsdom; every decision
        // delegates to the pure endpointing module, which is covered.
        "**/features/capture/liveCapture.ts",
        // Browser audio boundary for unified capture (#455): wraps the same MediaRecorder/Web Audio
        // live-capture seam into a one-shot record/stop, not exercisable in jsdom; CaptureCard's own
        // logic is covered.
        "**/features/capture/captureVoice.ts",
        // The pointer contextual gutter (#590): Tiptap's official drag handle renders into its own
        // hidden, detached portal and only becomes interactive under a real fine pointer (hover reveal
        // via onNodeChange, native drag-to-reorder, grip-triggered menu) — none of which jsdom can
        // synthesize. Its drag/reveal/drop-indicator/grip-menu behavior is covered by the Playwright
        // gutter e2e; every block action it renders is unit-tested through the always-available "More
        // block actions" trigger and Shift+F10 (RichContentEditor.test.tsx).
        "**/shared/editor/BlockGutterHandle.tsx",
        "**/src/**/*.type.ts",
        "**/src/**/*.types.ts",
        // Pure presentational design-token modules: static enum->class/style/motion maps, no logic.
        "**/src/**/*.tokens.ts",
        "**/src/**/*.tokens.tsx",
        "**/src/vite-env.d.ts"
      ],
      include: ["src/apps/*/src/**/*.{ts,tsx}", "src/packages/*/src/**/*.{ts,tsx}", "scripts/setup/**/*.mjs"],
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
    include: ["src/apps/**/*.{test,spec}.{ts,tsx}", "src/packages/**/*.{test,spec}.{ts,tsx}", "scripts/setup/**/*.{test,spec}.mjs"],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 30000
  }
});
