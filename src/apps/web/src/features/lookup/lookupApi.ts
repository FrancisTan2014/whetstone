import {
  parseLookupResponse,
  type LookupResponse,
  type LookupSourceId
} from "@whetstone/contracts";

// The lookup feature keeps its own fetch helper so it stays decoupled from the reader and notes
// features. One source is fetched per call so each tab loads independently; the response is
// validated at the boundary before the UI renders it.
export async function lookupTerm(
  term: string,
  language: string,
  source: LookupSourceId
): Promise<LookupResponse> {
  const query = `term=${encodeURIComponent(term)}&language=${encodeURIComponent(language)}&source=${source}`;
  const response = await fetch(`/api/lookup?${query}`);

  if (!response.ok) {
    throw new Error(`Lookup request failed with status ${response.status}.`);
  }

  return parseLookupResponse(await response.json());
}
