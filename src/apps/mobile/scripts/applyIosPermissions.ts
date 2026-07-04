import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ensureInfoPlistPermissions } from "../src/iosPermissions.js";

// Sync-time glue (macOS build flow): ensure the generated iOS Info.plist declares the microphone usage
// description, so a clean checkout that follows the shipped scripts produces a TestFlight-ready app
// without a manual, forgettable edit. Decision logic lives in ../src/iosPermissions.ts (unit-tested);
// this only does the file I/O and names the remedy on failure.

const plistPath = fileURLToPath(new URL("../ios/App/App/Info.plist", import.meta.url));

let plist: string;
try {
  plist = readFileSync(plistPath, "utf8");
} catch {
  console.error(
    `\n[apply:permissions] Could not read the iOS Info.plist at ${plistPath}. ` +
      "Generate the native project first (macOS):\n" +
      "  pnpm --filter @whetstone/mobile add:ios\n"
  );
  process.exit(1);
}

const patched = ensureInfoPlistPermissions(plist);

if (patched === plist) {
  console.log("[apply:permissions] NSMicrophoneUsageDescription already present; nothing to do.");
} else {
  writeFileSync(plistPath, patched, "utf8");
  console.log(`[apply:permissions] Added NSMicrophoneUsageDescription to ${plistPath}.`);
}
