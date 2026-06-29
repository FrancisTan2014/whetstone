import { defaultPreferences, preferencesSchema, type PreferencesDto } from "@whetstone/contracts";

// A best-effort cache of the last-known preferences so each control (text size in the reader, theme in
// the toggle) can PUT the whole record without re-fetching the other field. Server is the source of
// truth; this only bridges the two controls between a load and the next save.
let current: PreferencesDto = defaultPreferences;
// The in-flight load, so a save that fires before it resolves merges onto the real server record
// rather than module defaults — never clobbering the other field with a default (#234).
let inFlight: Promise<PreferencesDto> | undefined;

// Server is the source of truth for reader preferences (size + theme); fetched on load and saved
// best-effort on change so the controls keep working offline. Validated at the boundary.
export async function fetchPreferences(): Promise<PreferencesDto> {
  inFlight = (async () => {
    try {
      const response = await fetch("/api/preferences");

      if (!response.ok) {
        return current;
      }

      const body = (await response.json()) as { preferences?: unknown };
      const parsed = preferencesSchema.safeParse(body.preferences);
      current = parsed.success ? parsed.data : defaultPreferences;
      return current;
    } catch {
      return current;
    }
  })();

  return inFlight;
}

// Merge the changed field into the known record and upsert; failures never break reading. Waits for
// any in-flight load first so a single-field save preserves the other field's real server value.
export async function savePreferences(partial: Partial<PreferencesDto>): Promise<void> {
  if (inFlight !== undefined) {
    await inFlight;
  }

  current = { ...current, ...partial };
  try {
    await fetch("/api/preferences", {
      body: JSON.stringify(current),
      headers: { "content-type": "application/json" },
      method: "PUT"
    });
  } catch {
    // Best-effort: an offline save is dropped; the reader keeps working.
  }
}
