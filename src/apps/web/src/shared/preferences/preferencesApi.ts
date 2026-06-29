import { defaultPreferences, preferencesSchema, type PreferencesDto } from "@whetstone/contracts";

// A best-effort cache of the last-known preferences so each control (text size in the reader, theme in
// the toggle) can PUT the whole record without re-fetching the other field. Server is the source of
// truth; this only bridges the two controls between a load and the next save.
let current: PreferencesDto = defaultPreferences;
// The in-flight load, cleared on completion so saves only wait while a load is actually running, and a
// serial save chain so concurrent control changes merge onto one record — neither field clobbers the
// other and the last PUT carries both (#234).
let inFlight: Promise<PreferencesDto> | undefined;
let saveChain: Promise<void> = Promise.resolve();

export async function fetchPreferences(): Promise<PreferencesDto> {
  const load = (async () => {
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
    } finally {
      inFlight = undefined;
    }
  })();

  inFlight = load;
  return load;
}

// Merge the changed field and upsert, serialized so concurrent saves accumulate onto one record (the
// last PUT carries every field) and merge after any in-flight load. Failures never break reading.
export async function savePreferences(partial: Partial<PreferencesDto>): Promise<void> {
  saveChain = saveChain.then(async () => {
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
  });

  return saveChain;
}
