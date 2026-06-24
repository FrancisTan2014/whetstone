import { parseLookupResponse, type LookupResponse } from "@whetstone/contracts";

// The lookup feature keeps its own fetch helper so it stays decoupled from the reader and
// notes features. The response is validated at the boundary before the UI renders it.
export async function lookupTerm(term: string, language: string): Promise<LookupResponse> {
  const query = `term=${encodeURIComponent(term)}&language=${encodeURIComponent(language)}`;
  const response = await fetch(`/api/lookup?${query}`);

  if (!response.ok) {
    throw new Error(`Lookup request failed with status ${response.status}.`);
  }

  return parseLookupResponse(await response.json());
}
