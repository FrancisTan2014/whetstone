// Deep-links from a looked-up headword to mature external dictionaries (#254). The in-panel gloss is a
// quick reference; these jump-outs send the reader to fuller entries for the same term. v0 hardcodes
// three; user-configurable favourites come later. Outbound links only — never scraped or embedded.
export type ExternalDictionaryLink = Readonly<{ label: string; url: string }>;

const DICTIONARIES: ReadonlyArray<Readonly<{ base: string; label: string }>> = [
  { base: "https://www.ldoceonline.com/dictionary/", label: "Longman" },
  { base: "https://www.merriam-webster.com/dictionary/", label: "Merriam-Webster" },
  {
    base: "https://www.oxfordlearnersdictionaries.com/definition/english/",
    label: "Oxford Learner's"
  }
];

// Build the ordered deep-links for a headword. The term is URL-encoded so a multi-word or punctuated
// headword still resolves to a valid path segment rather than breaking the URL.
export function externalDictionaryLinks(headword: string): ReadonlyArray<ExternalDictionaryLink> {
  const encoded = encodeURIComponent(headword);

  return DICTIONARIES.map(({ base, label }) => ({ label, url: `${base}${encoded}` }));
}
