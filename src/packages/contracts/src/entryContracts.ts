import {
  createEntry,
  createEntryLink,
  createNoteAnchor,
  entryTypes,
  linkTypes,
  toEntryId,
  workTypes,
  type Entry,
  type EntryId,
  type EntryLink,
  type EntryType,
  type LinkType,
  type NoteAnchor,
  type WorkType
} from "@whetstone/domain";
import { z } from "zod";

export type EntryIdDto = EntryId;
export type EntryTypeDto = EntryType;
export type LinkTypeDto = LinkType;
export type WorkTypeDto = WorkType;
export type EntryLinkDto = EntryLink;
export type NoteAnchorDto = NoteAnchor;
export type EntryDto = Entry;

export const entryIdDtoSchema = z
  .string()
  .refine(isNonBlank, { message: "EntryId must be a non-empty string." })
  .transform((value) => toEntryId(value));

export const entryTypeDtoSchema = z.enum(entryTypes);

export const linkTypeDtoSchema = z.enum(linkTypes);

export const workTypeDtoSchema = z.enum(workTypes);

export const entryLinkDtoSchema = z
  .object({
    fromEntryId: entryIdDtoSchema,
    toEntryId: entryIdDtoSchema,
    type: linkTypeDtoSchema
  })
  .strict()
  .transform((link) => createEntryLink(link));

export const noteAnchorDtoSchema = z
  .object({
    contextSnapshot: z
      .string()
      .refine(isNonBlank, { message: "contextSnapshot must be non-empty." }),
    endOffset: z.number().int().nonnegative(),
    readingUnitEntryId: entryIdDtoSchema,
    selectedTextSnapshot: z
      .string()
      .refine(isNonBlank, { message: "selectedTextSnapshot must be non-empty." }),
    startOffset: z.number().int().nonnegative()
  })
  .strict()
  .refine((anchor) => anchor.endOffset > anchor.startOffset, {
    message: "endOffset must be greater than startOffset.",
    path: ["endOffset"]
  })
  .refine((anchor) => anchor.contextSnapshot.includes(anchor.selectedTextSnapshot), {
    message: "contextSnapshot must contain selectedTextSnapshot.",
    path: ["contextSnapshot"]
  })
  .transform((anchor) => createNoteAnchor(anchor));

export const entryDtoSchema = z
  .object({
    id: entryIdDtoSchema,
    links: z.array(entryLinkDtoSchema),
    type: entryTypeDtoSchema
  })
  .strict()
  .transform((entry) => createEntry(entry));

export function parseEntryIdDto(value: unknown): EntryIdDto {
  return entryIdDtoSchema.parse(value);
}

export function parseEntryTypeDto(value: unknown): EntryTypeDto {
  return entryTypeDtoSchema.parse(value);
}

export function parseLinkTypeDto(value: unknown): LinkTypeDto {
  return linkTypeDtoSchema.parse(value);
}

export function parseWorkTypeDto(value: unknown): WorkTypeDto {
  return workTypeDtoSchema.parse(value);
}

export function parseEntryLinkDto(value: unknown): EntryLinkDto {
  return entryLinkDtoSchema.parse(value);
}

export function parseNoteAnchorDto(value: unknown): NoteAnchorDto {
  return noteAnchorDtoSchema.parse(value);
}

export function parseEntryDto(value: unknown): EntryDto {
  return entryDtoSchema.parse(value);
}

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}
