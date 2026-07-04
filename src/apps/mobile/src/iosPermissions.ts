// The iOS shell must declare why it uses the microphone, or iOS kills the app the moment Practice
// requests capture. Capacitor generates Info.plist once (on macOS, via `cap add ios`) without this
// key, so — rather than a manual, forgettable edit — the mobile setup/sync flow runs a checked-in
// patch (scripts/applyIosPermissions.ts) built on these pure, testable helpers. Keeping the logic here
// (not in the I/O script) lets it be unit-tested without a native project.

export const microphoneUsageDescription =
  "Whetstone uses the microphone for spoken Practice sessions.";

const microphoneUsageKey = "NSMicrophoneUsageDescription";
const topLevelDictOpen = "<dict>";

// Ensure Info.plist declares the microphone usage description, returning the patched XML. Idempotent:
// if the key is already present the document is returned unchanged (never duplicated), so it is safe to
// re-run on every `sync`. Fails loud when the document has no top-level `<dict>` rather than silently
// producing a plist without the permission.
export function ensureInfoPlistPermissions(plistXml: string): string {
  if (plistXml.includes(`<key>${microphoneUsageKey}</key>`)) {
    return plistXml;
  }

  const dictIndex = plistXml.indexOf(topLevelDictOpen);

  if (dictIndex === -1) {
    throw new Error(
      "Cannot patch Info.plist: no top-level <dict> found. " +
        "Re-run `cap add ios` on macOS to regenerate the iOS project, then retry."
    );
  }

  const insertAt = dictIndex + topLevelDictOpen.length;
  const entry = `\n\t<key>${microphoneUsageKey}</key>\n\t<string>${microphoneUsageDescription}</string>`;

  return plistXml.slice(0, insertAt) + entry + plistXml.slice(insertAt);
}
