import { z } from "zod";

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

// The reading->practice nudge (#245): a single recent reading capture surfaced as a practice prompt.
// The client never supplies the owning user (the server resolves the current user) nor the ranking
// (the server derives it live). `blockEntryId` is optional — the source block, present for a capture
// anchored to reading, so the card can name/deep-link its provenance.
export const nudgeDtoSchema = z
  .object({
    blockEntryId: z
      .string()
      .refine(isNonBlank, { message: "blockEntryId must be non-empty." })
      .optional(),
    caseId: z.string(),
    chunkId: z.string(),
    text: z.string(),
    workTitle: z.string()
  })
  .strict();

export type NudgeDto = z.infer<typeof nudgeDtoSchema>;

// The GET /api/nudge result: the proposed nudge, or an explicit null so the client renders nothing
// (no card, no placeholder) instead of guessing from an empty body.
export const nudgeResponseSchema = z.object({ nudge: nudgeDtoSchema.nullable() }).strict();

export type NudgeResponse = z.infer<typeof nudgeResponseSchema>;

export function parseNudgeDto(value: unknown): NudgeDto {
  return nudgeDtoSchema.parse(value);
}

export function parseNudgeResponse(value: unknown): NudgeResponse {
  return nudgeResponseSchema.parse(value);
}
