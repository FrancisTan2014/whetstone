import { z } from "zod";

// The search route query: a non-empty (trimmed) term searched across block text. The term is
// trimmed in-place so the matcher and the echoed `query` receive the cleaned value.
export const searchRequestSchema = z
  .object({
    q: z.string().trim().min(1, { message: "q must be non-empty." })
  })
  .strict();

export type SearchRequest = z.infer<typeof searchRequestSchema>;

export function parseSearchRequest(value: unknown): SearchRequest {
  return searchRequestSchema.parse(value);
}

// One search hit's bounded display payload: the clipped source text around the first match, the
// match's canonical UTF-16 range within that text (so the client highlights exactly the matched
// characters), and whether either end was clipped (the UI shows an ellipsis only then). See
// `buildSearchSnippet` in `@whetstone/domain` for how it is derived; ellipsis characters are not baked
// into `text`, so the offsets index `text` directly.
export const searchSnippetSchema = z
  .object({
    text: z.string(),
    matchStart: z.number().int().nonnegative(),
    matchEnd: z.number().int().nonnegative(),
    hasLeadingEllipsis: z.boolean(),
    hasTrailingEllipsis: z.boolean()
  })
  .strict();

export type SearchSnippetDto = z.infer<typeof searchSnippetSchema>;

// One block-level search hit: enough to show the match (author, work title, the bounded snippet) and
// to deep-link the reader to the exact block (`workEntryId` + `blockEntryId`).
export const searchResultDtoSchema = z
  .object({
    authorName: z.string(),
    blockEntryId: z.string(),
    snippet: searchSnippetSchema,
    workEntryId: z.string(),
    workTitle: z.string()
  })
  .strict();

export type SearchResultDto = z.infer<typeof searchResultDtoSchema>;

// The search response echoes the normalized query and the ordered hits, so the client renders an
// explicit "no matches for <query>" state instead of guessing from an empty body.
export const searchResultsDtoSchema = z
  .object({
    query: z.string(),
    results: z.array(searchResultDtoSchema)
  })
  .strict();

export type SearchResultsDto = z.infer<typeof searchResultsDtoSchema>;

export function parseSearchResults(value: unknown): SearchResultsDto {
  return searchResultsDtoSchema.parse(value);
}
