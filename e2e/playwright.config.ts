import { defineConfig, devices } from "@playwright/test";

// Deterministic E2E smoke gate (issue #121). Single worker, no retries: a flake must be fixed or
// quarantined, never papered over. globalSetup boots the real stack and seeds it; specs read the
// base URL + work ids from the fixture. Wired into `pnpm validate` and CI after `pnpm build`,
// which produces the server dist the stack runs.
export default defineConfig({
  testDir: "./tests",
  outputDir: "./.tmp/test-results",
  globalSetup: "./globalSetup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? "line" : "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    headless: true,
    trace: "off"
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
