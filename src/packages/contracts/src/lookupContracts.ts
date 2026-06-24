import { z } from "zod";

// A single normalized sense: the shared, source-agnostic shape the reader renders. Both
// the Merriam-Webster and Free Dictionary adapters collapse their verbose wire formats
// into this, so the client never depends on a provider's JSON.
export const normalizedSenseSchema = z
  .object({
    example: z.string().optional(),
    gloss: z.string(),
    partOfSpeech: z.string().optional()
  })
  .strict();

export type NormalizedSense = z.infer<typeof normalizedSenseSchema>;

// One headword's normalized entry. `senses` is already capped by the adapter so results
// stay scannable; pronunciation is optional because not every source supplies one.
export const normalizedEntrySchema = z
  .object({
    headword: z.string(),
    pronunciation: z.string().optional(),
    senses: z.array(normalizedSenseSchema)
  })
  .strict();

export type NormalizedEntry = z.infer<typeof normalizedEntrySchema>;

// The route result is a discriminated union: a found entry (with optional required-source
// attribution) or an explicit not-found, so the client renders an empty state instead of
// guessing from a null body.
export const lookupResponseSchema = z.discriminatedUnion("found", [
  z
    .object({
      attribution: z.string().optional(),
      entry: normalizedEntrySchema,
      found: z.literal(true)
    })
    .strict(),
  z.object({ found: z.literal(false) }).strict()
]);

export type LookupResponse = z.infer<typeof lookupResponseSchema>;

export function parseLookupResponse(value: unknown): LookupResponse {
  return lookupResponseSchema.parse(value);
}

// The lookup route query: a non-empty (trimmed) term and, for now, English only. The term
// is trimmed in-place so callers downstream receive the cleaned value.
export const lookupRequestSchema = z
  .object({
    language: z.literal("en"),
    term: z.string().trim().min(1, { message: "term must be non-empty." })
  })
  .strict();

export type LookupRequest = z.infer<typeof lookupRequestSchema>;

export function parseLookupRequest(value: unknown): LookupRequest {
  return lookupRequestSchema.parse(value);
}
