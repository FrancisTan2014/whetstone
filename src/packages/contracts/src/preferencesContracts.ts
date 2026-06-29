import { z } from "zod";

// User-owned reader preferences (#234): text size and Day/Night theme, server-owned so they restore
// on any device. Values mirror the reader controls (sm|md|lg|xl size; day|night theme); the record is
// designed to grow — future settings join as fields without a new endpoint.
export const readingSizes = ["sm", "md", "lg", "xl"] as const;
export const themes = ["day", "night"] as const;

export const preferencesSchema = z
  .object({
    readingSize: z.enum(readingSizes),
    theme: z.enum(themes)
  })
  .strict();

export type PreferencesDto = z.infer<typeof preferencesSchema>;

export const defaultPreferences: PreferencesDto = { readingSize: "md", theme: "day" };

export function parsePreferences(value: unknown): PreferencesDto {
  return preferencesSchema.parse(value);
}

// PUT body upserts the whole record; both fields are required so a save always stores a coherent state.
export const upsertPreferencesRequestSchema = preferencesSchema;

export type UpsertPreferencesRequest = z.infer<typeof upsertPreferencesRequestSchema>;

export function parseUpsertPreferencesRequest(value: unknown): UpsertPreferencesRequest {
  return upsertPreferencesRequestSchema.parse(value);
}
