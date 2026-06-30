// Deep-links from a looked-up headword to mature external dictionaries (#254). The in-panel gloss is a
// quick reference; these jump-outs send the reader to fuller entries for the same term. The set is
// language-aware (#296): an English headword gets English learner dictionaries; a Chinese (CJK)
// headword gets Chinese dictionaries (where the English ones have no entry, #302). Outbound links
// only — never scraped or embedded.
export type ExternalDictionaryLink = Readonly<{ label: string; url: string }>;

// Each English dictionary owns how it builds a URL from the normalized (lowercased) headword, because
// the verified deep-link shapes differ (#303): Longman and Merriam-Webster lemmatize a path segment
// server-side, while Oxford only resolves an inflected form (e.g. "viewpoints" -> "viewpoint") through
// its search endpoint, not /definition/. Longman's path joins multi-word terms with hyphens; the
// others percent-encode the space.
const ENGLISH_DICTIONARIES: ReadonlyArray<
  Readonly<{ label: string; build: (lower: string) => string }>
> = [
  {
    label: "Longman",
    build: (lower) =>
      `https://www.ldoceonline.com/dictionary/${encodeURIComponent(lower.replace(/ +/g, "-"))}`
  },
  {
    label: "Merriam-Webster",
    build: (lower) => `https://www.merriam-webster.com/dictionary/${encodeURIComponent(lower)}`
  },
  {
    label: "Oxford Learner's",
    build: (lower) =>
      `https://www.oxfordlearnersdictionaries.com/search/english/direct/?q=${encodeURIComponent(lower)}`
  }
];

// Each Chinese dictionary builds a URL from the URL-encoded headword (never lowercased — CJK has no
// case). 汉典 and 萌典 take the word in the path/fragment; ctext and 国学大师 take it as a query
// parameter. 国学大师's exact deep-link shape is best-effort (its entry URLs are not a documented,
// stable pattern), so this points at its dictionary search, which reliably resolves the character.
const CHINESE_DICTIONARIES: ReadonlyArray<
  Readonly<{ label: string; build: (encoded: string) => string }>
> = [
  {
    label: "汉典",
    build: (encoded) => `https://www.zdic.net/hans/${encoded}`
  },
  {
    label: "萌典",
    build: (encoded) => `https://www.moedict.tw/#${encoded}`
  },
  {
    label: "ctext",
    build: (encoded) => `https://ctext.org/dictionary.pl?if=gb&char=${encoded}`
  },
  {
    // Best-effort deep link: 国学大师 has no documented stable per-entry URL, so search by character.
    label: "国学大师",
    build: (encoded) => `https://www.guoxuedashi.net/so.php?sokeyzi=${encoded}&submit=&kind=zi`
  }
];

// CJK ideographs (the same range the language-mix metric scores): their presence in a headword marks
// it as a Chinese lookup.
const cjkPattern = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const latinPattern = /[A-Za-z]/;

// A headword the English learner dictionaries can actually resolve: it must be written in the Latin
// script (at least one Latin letter) and carry no CJK ideograph. This routes English lookups to the
// English dictionaries and Chinese ones to the Chinese dictionaries (#302).
export function isEnglishHeadword(headword: string): boolean {
  return latinPattern.test(headword) && !cjkPattern.test(headword);
}

// Build the ordered deep-links for a headword. An English headword is lowercased and URL-encoded so an
// inflected, multi-word, or punctuated form still resolves (each site lemmatizes its own form); a
// Chinese (CJK) headword is URL-encoded as-is (no lowercasing) and routed to the Chinese dictionaries
// instead of pointing English sites at a word they have no entry for (#296/#302).
export function externalDictionaryLinks(headword: string): ReadonlyArray<ExternalDictionaryLink> {
  if (!isEnglishHeadword(headword)) {
    const encoded = encodeURIComponent(headword);
    return CHINESE_DICTIONARIES.map(({ label, build }) => ({ label, url: build(encoded) }));
  }

  const lower = headword.toLowerCase();

  return ENGLISH_DICTIONARIES.map(({ label, build }) => ({ label, url: build(lower) }));
}
