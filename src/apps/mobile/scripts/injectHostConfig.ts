import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { hostRuntimeConfigSchema } from "@whetstone/contracts";

import {
  hostConfigInjectionScript,
  injectHostConfigScript,
  iosHostConfig
} from "../src/hostConfig.js";

// Sync-time glue (macOS build flow): after `cap sync ios` copies the built web assets into the native
// iOS project, inject the host runtime config into the copied index.html so the app calls the right API
// base instead of a meaningless same-origin `/api`. This is the file-I/O boundary; all decision logic
// lives in ../src/hostConfig.ts, which is unit-tested. Every failure path names the remedy so a build
// operator is never left guessing.

function fail(message: string): never {
  console.error(`\n[inject:config] ${message}\n`);
  process.exit(1);
}

const apiBaseUrl = process.env.WHETSTONE_API_BASE_URL?.trim();

if (!apiBaseUrl) {
  fail(
    "WHETSTONE_API_BASE_URL is not set. The iOS app cannot use a same-origin /api, so an absolute " +
      "API base is required. Set it before syncing, e.g.\n" +
      '  WHETSTONE_API_BASE_URL="https://your-server.example/api" pnpm --filter @whetstone/mobile sync'
  );
}

const config = iosHostConfig(apiBaseUrl);
const parsed = hostRuntimeConfigSchema.safeParse(config);

if (!parsed.success) {
  const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
  fail(
    `WHETSTONE_API_BASE_URL="${apiBaseUrl}" is not a valid iOS API base (${detail}). ` +
      "Use an absolute http(s) URL, e.g. https://your-server.example/api."
  );
}

const indexPath = fileURLToPath(new URL("../ios/App/App/public/index.html", import.meta.url));

let html: string;
try {
  html = readFileSync(indexPath, "utf8");
} catch {
  fail(
    `Could not read the synced web index.html at ${indexPath}. Run the iOS platform steps first:\n` +
      "  pnpm --filter @whetstone/mobile add:ios   # once, on macOS\n" +
      "  pnpm --filter @whetstone/mobile sync      # builds the web app and runs cap sync ios"
  );
}

writeFileSync(indexPath, injectHostConfigScript(html, hostConfigInjectionScript(config)), "utf8");

console.log(
  `[inject:config] Injected iOS host config (apiBaseUrl=${config.apiBaseUrl}) into ${indexPath}`
);
