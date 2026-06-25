import { z } from "zod";

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

// The client supplies the reading unit it last had open and an optional best-effort block anchor
// (the topmost visible block within that unit); it NEVER supplies a user id — the server resolves
// the current user. `anchorBlockEntryId` is optional and nullable: absent or null means the top of
// the unit.
export const upsertReadingPositionRequestSchema = z
  .object({
    anchorBlockEntryId: z
      .string()
      .refine(isNonBlank, { message: "anchorBlockEntryId must be non-empty." })
      .nullish(),
    unitEntryId: z.string().refine(isNonBlank, { message: "unitEntryId must be non-empty." })
  })
  .strict();

export type UpsertReadingPositionRequest = z.infer<typeof upsertReadingPositionRequestSchema>;

// The stored position the reader resumes to: the unit and an optional block anchor (null/absent =
// top of the unit). Kept minimal — the work is already known from the request path.
export const readingPositionDtoSchema = z
  .object({
    anchorBlockEntryId: z.string().nullish(),
    unitEntryId: z.string()
  })
  .strict();

export type ReadingPositionDto = z.infer<typeof readingPositionDtoSchema>;

// The GET result: the saved position, or an explicit null so the client renders the first unit
// instead of guessing from an empty body.
export const readingPositionResponseSchema = z
  .object({
    position: readingPositionDtoSchema.nullable()
  })
  .strict();

export type ReadingPositionResponse = z.infer<typeof readingPositionResponseSchema>;

export function parseUpsertReadingPositionRequest(value: unknown): UpsertReadingPositionRequest {
  return upsertReadingPositionRequestSchema.parse(value);
}

export function parseReadingPositionResponse(value: unknown): ReadingPositionResponse {
  return readingPositionResponseSchema.parse(value);
}
