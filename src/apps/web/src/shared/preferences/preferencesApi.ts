import {
  defaultPreferences,
  storedPreferencesSchema,
  type PreferencesDto
} from "@whetstone/contracts";

import { apiUrl } from "../runtime";

// The browser's resolved IANA zone, or UTC when the runtime can't report one. The learner's calendar-day
// zone defaults from this once (#606); the server then owns it.
export function resolveBrowserTimeZone(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return resolved.length > 0 ? resolved : defaultPreferences.timeZone;
  } catch {
    return defaultPreferences.timeZone;
  }
}

// A best-effort cache of the last-known preferences so each control (text size in the reader, theme in
// the toggle) can PUT the whole record without re-fetching the other field. Server is the source of
// truth; this only bridges the controls between a load and the next save. The zone starts from the
// browser so any save before the first load still carries a valid IANA id.
let current: PreferencesDto = { ...defaultPreferences, timeZone: resolveBrowserTimeZone() };
// The in-flight load, cleared on completion so saves only wait while a load is actually running, and a
// serial save chain so concurrent control changes merge onto one record — neither field clobbers the
// other and the last PUT carries both (#234).
let inFlight: Promise<PreferencesDto> | undefined;
let saveChain: Promise<void> = Promise.resolve();

export async function fetchPreferences(): Promise<PreferencesDto> {
  const load = (async () => {
    try {
      const response = await fetch(apiUrl("/preferences"));

      if (!response.ok) {
        return current;
      }

      const body = (await response.json()) as { preferences?: unknown };
      const parsed = storedPreferencesSchema.safeParse(body.preferences);
      if (!parsed.success) {
        // Same contract as #234: a malformed body resets the cache to a safe default record (with the
        // browser's zone), rather than trusting garbage.
        current = { ...defaultPreferences, timeZone: resolveBrowserTimeZone() };
        return current;
      }

      // A null stored zone means first use: adopt the browser's zone and persist it exactly once (#606),
      // so a later query groups by the learner's calendar day rather than the server's.
      const browserZone = resolveBrowserTimeZone();
      current = {
        readingSize: parsed.data.readingSize,
        theme: parsed.data.theme,
        timeZone: parsed.data.timeZone ?? browserZone
      };
      if (parsed.data.timeZone === null) {
        void savePreferences({ timeZone: browserZone });
      }
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
      await fetch(apiUrl("/preferences"), {
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
