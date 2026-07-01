import {
  parseLookupResponse,
  type LookupResponse,
  type LookupSourceId
} from "@whetstone/contracts";

// The lookup feature keeps its own fetch helper so it stays decoupled from the reader and notes
// features. One source is fetched per call so each tab loads independently; the response is
// validated at the boundary before the UI renders it. `context` (the selection's containing block
// text) is sent only for the local-LLM source (#341) so it can gloss the term in context; it is
// truncated to a sane bound so a large block never bloats the query string.
const maxContextLength = 1000;

export async function lookupTerm(
  term: string,
  language: string,
  source: LookupSourceId,
  context?: string
): Promise<LookupResponse> {
  const base = `term=${encodeURIComponent(term)}&language=${encodeURIComponent(language)}&source=${source}`;
  const query =
    context === undefined
      ? base
      : `${base}&context=${encodeURIComponent(context.slice(0, maxContextLength))}`;
  const response = await fetch(`/api/lookup?${query}`);

  if (!response.ok) {
    throw new Error(`Lookup request failed with status ${response.status}.`);
  }

  return parseLookupResponse(await response.json());
}
