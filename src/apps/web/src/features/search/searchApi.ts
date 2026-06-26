import { parseSearchResults, type SearchResultsDto } from "@whetstone/contracts";

// The search feature keeps its own fetch helper so it stays decoupled from the reader and
// library features. The response is validated at the boundary before the UI renders it.
export async function searchLibrary(query: string): Promise<SearchResultsDto> {
  const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);

  if (!response.ok) {
    throw new Error(`Search request failed with status ${response.status}.`);
  }

  return parseSearchResults(await response.json());
}
