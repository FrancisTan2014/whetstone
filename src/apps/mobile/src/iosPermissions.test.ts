import { describe, expect, it } from "vitest";

import { ensureInfoPlistPermissions, microphoneUsageDescription } from "./iosPermissions";

const emptyPlist =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>App</string>\n</dict>\n</plist>\n';

describe("ensureInfoPlistPermissions", () => {
  it("adds the microphone usage description when it is absent", () => {
    const patched = ensureInfoPlistPermissions(emptyPlist);

    expect(patched).toContain("<key>NSMicrophoneUsageDescription</key>");
    expect(patched).toContain(`<string>${microphoneUsageDescription}</string>`);
    // Inserted inside the top-level dict, before its existing keys.
    expect(patched.indexOf("<key>NSMicrophoneUsageDescription</key>")).toBeLessThan(
      patched.indexOf("<key>CFBundleName</key>")
    );
  });

  it("is idempotent: an already-patched plist is returned unchanged (no duplicate key)", () => {
    const once = ensureInfoPlistPermissions(emptyPlist);
    const twice = ensureInfoPlistPermissions(once);

    expect(twice).toBe(once);
    expect(twice.match(/<key>NSMicrophoneUsageDescription<\/key>/g)).toHaveLength(1);
  });

  it("fails loud when the document has no top-level <dict>", () => {
    expect(() => ensureInfoPlistPermissions("<plist></plist>")).toThrow(/no top-level <dict>/);
  });
});
