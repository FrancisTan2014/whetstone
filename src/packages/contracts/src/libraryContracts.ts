import { toAuthorId, type AuthorId, type EntryId, type WorkType } from "@whetstone/domain";
import { z } from "zod";

import { workTypeDtoSchema } from "./entryContracts.js";

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

export const authorIdDtoSchema = z
  .string()
  .refine(isNonBlank, { message: "AuthorId must be a non-empty string." })
  .transform((value) => toAuthorId(value));

export const createAuthorRequestSchema = z
  .object({
    name: z.string().refine(isNonBlank, { message: "Author name must be non-empty." })
  })
  .strict();

// Creating a work either references an existing author or names a new one inline.
export const workAuthorSelectionSchema = z.discriminatedUnion("mode", [
  z
    .object({
      authorId: authorIdDtoSchema,
      mode: z.literal("existing")
    })
    .strict(),
  z
    .object({
      mode: z.literal("new"),
      name: z.string().refine(isNonBlank, { message: "Author name must be non-empty." })
    })
    .strict()
]);

export const createWorkRequestSchema = z
  .object({
    author: workAuthorSelectionSchema,
    language: z.string().refine(isNonBlank, { message: "Work language must be non-empty." }),
    title: z.string().refine(isNonBlank, { message: "Work title must be non-empty." }),
    workType: workTypeDtoSchema
  })
  .strict();

export type CreateAuthorRequest = z.infer<typeof createAuthorRequestSchema>;
export type WorkAuthorSelection = z.infer<typeof workAuthorSelectionSchema>;
export type CreateWorkRequest = z.infer<typeof createWorkRequestSchema>;

export type AuthorDto = Readonly<{
  id: AuthorId;
  name: string;
}>;

export type WorkDto = Readonly<{
  authorId: AuthorId;
  entryId: EntryId;
  language: string;
  title: string;
  workType: WorkType;
}>;

export type WorkListItemDto = Readonly<{
  author: AuthorDto;
  work: WorkDto;
}>;

export type AuthorListDto = Readonly<{
  authors: ReadonlyArray<AuthorDto>;
}>;

export type WorkListDto = Readonly<{
  works: ReadonlyArray<WorkListItemDto>;
}>;

export function parseCreateAuthorRequest(value: unknown): CreateAuthorRequest {
  return createAuthorRequestSchema.parse(value);
}

export function parseCreateWorkRequest(value: unknown): CreateWorkRequest {
  return createWorkRequestSchema.parse(value);
}
