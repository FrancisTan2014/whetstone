import { isTimeZone } from "@whetstone/domain";
import { z } from "zod";

// User-owned reader preferences (#234): text size and Day/Night theme, server-owned so they restore
// on any device. Values mirror the reader controls (sm|md|lg|xl size; day|night theme); the record is
// designed to grow — future settings join as fields without a new endpoint (#606 added `timeZone`).
export const readingSizes = ["sm", "md", "lg", "xl"] as const;
export const themes = ["day", "night"] as const;

// A validated IANA timezone id — the learner's one calendar-day zone (#606). Validation is the runtime's
// own `Intl` database, so an unknown id is rejected at the boundary rather than silently reinterpreted as
// the server's zone.
export const ianaTimeZoneSchema = z
  .string()
  .refine((value) => isTimeZone(value), { message: "invalid_timezone" });

// The full, coherent preferences record a save stores and the client caches. `timeZone` is a validated
// IANA id, always present on a save.
export const preferencesSchema = z
  .object({
    readingSize: z.enum(readingSizes),
    theme: z.enum(themes),
    timeZone: ianaTimeZoneSchema
  })
  .strict();

export type PreferencesDto = z.infer<typeof preferencesSchema>;

// What GET returns: the same record, but `timeZone` may be null until first-use defaulting persists the
// browser's resolved zone. A null `timeZone` is the signal the client uses to send its zone exactly once.
export const storedPreferencesSchema = z
  .object({
    readingSize: z.enum(readingSizes),
    theme: z.enum(themes),
    timeZone: ianaTimeZoneSchema.nullable()
  })
  .strict();

export type StoredPreferencesDto = z.infer<typeof storedPreferencesSchema>;

// The default reading experience before any save. `timeZone` defaults to UTC as a safe, machine-
// independent fallback; the client replaces it with the browser's resolved zone on first use.
export const defaultPreferences: PreferencesDto = {
  readingSize: "md",
  theme: "day",
  timeZone: "UTC"
};

export function parsePreferences(value: unknown): PreferencesDto {
  return preferencesSchema.parse(value);
}

export function parseStoredPreferences(value: unknown): StoredPreferencesDto {
  return storedPreferencesSchema.parse(value);
}

// PUT body upserts the whole record; every field is required so a save always stores a coherent state.
export const upsertPreferencesRequestSchema = preferencesSchema;

export type UpsertPreferencesRequest = z.infer<typeof upsertPreferencesRequestSchema>;

export function parseUpsertPreferencesRequest(value: unknown): UpsertPreferencesRequest {
  return upsertPreferencesRequestSchema.parse(value);
}
