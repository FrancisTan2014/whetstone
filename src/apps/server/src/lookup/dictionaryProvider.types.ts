// The DictionaryProvider seam: vocabulary-lookup sources implement this so callers (and,
// later, the reader UI) depend only on this normalized shape — never on a source's wire
// format, transport, or caching. The normalized shape is the shared contract
// (`@whetstone/contracts`) so client and server agree on one definition; this file
// re-exports it and keeps the server-only provider interface alongside.

import type { NormalizedEntry } from "@whetstone/contracts";

export type { NormalizedEntry, NormalizedSense } from "@whetstone/contracts";

export interface DictionaryProvider {
  // Resolves to the normalized entry, or null when the term has no entry for the language.
  lookup(term: string, language: string): Promise<NormalizedEntry | null>;
}
