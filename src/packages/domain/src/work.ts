export const workTypes = ["book", "essay", "blog_post", "classical_text"] as const;

export type WorkType = (typeof workTypes)[number];

const workTypeSet: ReadonlySet<unknown> = new Set(workTypes);

export function isWorkType(value: unknown): value is WorkType {
  return workTypeSet.has(value);
}

// v0 supports exactly three work languages, stored as fixed BCP-47 codes chosen from a
// dropdown (no free-text): Simplified Chinese, Traditional Chinese, English. The codes
// map onto the language-aware reading font stacks so the reader can use them later.
export const workLanguages = ["zh-CN", "zh-TW", "en"] as const;

export type WorkLanguage = (typeof workLanguages)[number];

const workLanguageSet: ReadonlySet<unknown> = new Set(workLanguages);

export function isWorkLanguage(value: unknown): value is WorkLanguage {
  return workLanguageSet.has(value);
}

export const workLanguageLabels: Readonly<Record<WorkLanguage, string>> = {
  en: "English",
  "zh-CN": "中文（简体） Simplified Chinese",
  "zh-TW": "中文（繁體） Traditional Chinese"
};

const traditionalChineseTags: ReadonlySet<string> = new Set(["zh-tw", "zh-hant", "zh-hk", "zh-mo"]);
const simplifiedChineseTags: ReadonlySet<string> = new Set(["zh", "zh-cn", "zh-hans", "zh-sg"]);

// Normalize any source language tag (manual input, EPUB OPF metadata, legacy rows) into
// the v0 set: Traditional Chinese variants -> zh-TW, Simplified variants -> zh-CN, and
// everything else (including English regional variants and unknown/`und`) -> en.
export function normalizeWorkLanguage(raw: string): WorkLanguage {
  const value = raw.trim().toLowerCase();

  if (value.startsWith("en")) {
    return "en";
  }

  if (traditionalChineseTags.has(value)) {
    return "zh-TW";
  }

  if (simplifiedChineseTags.has(value)) {
    return "zh-CN";
  }

  return "en";
}
