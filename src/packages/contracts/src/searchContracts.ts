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

// One block-level search hit: enough to show the match (author, work title, the block's text) and
// to deep-link the reader to the exact block (`workEntryId` + `blockEntryId`).
export const searchResultDtoSchema = z
  .object({
    authorName: z.string(),
    blockEntryId: z.string(),
    plaintext: z.string(),
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
