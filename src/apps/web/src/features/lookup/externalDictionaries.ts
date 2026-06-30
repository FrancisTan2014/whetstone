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

// CJK ideographs (the same range the language-mix metric scores): their presence in a headword marks
// it as a Chinese lookup. English learner dictionaries are useless for such words (#302), so the
// deep-links are gated out rather than pointed at a page that has no entry for 曰.
const cjkPattern = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const latinPattern = /[A-Za-z]/;

// A headword these English learner dictionaries can actually resolve: it must be written in the Latin
// script (at least one Latin letter) and carry no CJK ideograph. This shows the links for English
// lookups and hides them for Chinese ones (萌典/CC-CEDICT headwords), per #302.
export function isEnglishHeadword(headword: string): boolean {
  return latinPattern.test(headword) && !cjkPattern.test(headword);
}

// Build the ordered deep-links for a headword, or none for a non-English (CJK) headword. The term is
// URL-encoded so a multi-word or punctuated headword still resolves to a valid path segment rather
// than breaking the URL.
export function externalDictionaryLinks(headword: string): ReadonlyArray<ExternalDictionaryLink> {
  if (!isEnglishHeadword(headword)) {
    return [];
  }

  const encoded = encodeURIComponent(headword);

  return DICTIONARIES.map(({ base, label }) => ({ label, url: `${base}${encoded}` }));
}
