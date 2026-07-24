import {
  toAuthorId,
  libraryCreateOrigins,
  type AuthorId,
  type EntryId,
  type LibraryCreateOrigin,
  type WorkLanguage,
  type WorkOrigin,
  type WorkType
} from "@whetstone/domain";
import { z } from "zod";

import { workLanguageDtoSchema, workTypeDtoSchema } from "./entryContracts.js";

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

// Library create carries the caller's explicit content-authority intent (#695): `manual` (a
// learner-curated Work edited from the Library) or `imported` (an upload shell ingestion later fills).
// `authored` is not accepted here — an owned Work is minted only by the Writing path — so a client can
// never forge an owned Work through this endpoint. The server stamps the origin (and, for `manual`, the
// ownership facet) in one transaction from this declared intent.
export const libraryCreateOriginDtoSchema = z.enum(libraryCreateOrigins);

export const createWorkRequestSchema = z
  .object({
    author: workAuthorSelectionSchema,
    language: workLanguageDtoSchema,
    origin: libraryCreateOriginDtoSchema,
    title: z.string().refine(isNonBlank, { message: "Work title must be non-empty." }),
    workType: workTypeDtoSchema
  })
  .strict();

// Begin a MANUAL Work through the duplicate-review boundary (#749). A manual Work is always
// learner-curated with a canonical empty document, so the origin is implicit (`manual`) and never
// accepted from the client — this is the same metadata as `createWorkRequestSchema` minus `origin`. The
// server reviews #724 candidates before any commit; with none it creates immediately through the same
// canonical empty-document boundary, and with a credible one it parks the shared review. It carries no
// uploaded bytes, so there is no source hash or stage and an exact-source reopen is impossible.
export const beginManualWorkRequestSchema = z
  .object({
    author: workAuthorSelectionSchema,
    language: workLanguageDtoSchema,
    title: z.string().refine(isNonBlank, { message: "Work title must be non-empty." }),
    workType: workTypeDtoSchema
  })
  .strict();

export type CreateAuthorRequest = z.infer<typeof createAuthorRequestSchema>;
export type WorkAuthorSelection = z.infer<typeof workAuthorSelectionSchema>;
export type CreateWorkRequest = z.infer<typeof createWorkRequestSchema>;
export type BeginManualWorkRequest = z.infer<typeof beginManualWorkRequestSchema>;
export type LibraryCreateOriginDto = LibraryCreateOrigin;

export type AuthorDto = Readonly<{
  id: AuthorId;
  name: string;
}>;

// A Work's projected identity for Library and route composition. `origin` is projected here once (#695)
// so consumers read the content authority directly instead of inferring it with extra provenance or
// ownership queries.
export type WorkDto = Readonly<{
  authorId: AuthorId;
  entryId: EntryId;
  language: WorkLanguage;
  origin: WorkOrigin;
  title: string;
  workType: WorkType;
}>;

export type WorkListItemDto = Readonly<{
  author: AuthorDto;
  work: WorkDto;
}>;

// The create-or-select author field's search boundary (#694). `authors` are the canonical-key substring
// matches (alphabetical; owner-keyed "You" rows excluded). `exactMatchId` is the id whose canonical key
// equals the query (case/width/whitespace-insensitive), authoritative for suppressing "Add". `cleanedQuery`
// is the server-cleaned display name the client shows in the `Add "{name}"` affordance — canonicalization
// never happens on the client.
export type AuthorSearchDto = Readonly<{
  authors: ReadonlyArray<AuthorDto>;
  cleanedQuery: string;
  exactMatchId: AuthorId | null;
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

export function parseBeginManualWorkRequest(value: unknown): BeginManualWorkRequest {
  return beginManualWorkRequestSchema.parse(value);
}
