// The CJK "cut" layer (#342): before lookup, snap a raw tap/selection to the word under it, so every
// tab (dictionaries and the #341 AI explain tab) queries a real word (六艺, not 六). CJK has no word
// spaces, so a tap is ambiguous; the platform `Intl.Segmenter` does dictionary-based word segmentation
// with zero JS bundle weight (native), which is the ecosystem-native v0 choice.

// The word span of a block's text: a half-open `[start, end)` character range plus its text.
export type WordSpan = Readonly<{ end: number; start: number; text: string }>;

// Han ideographs (incl. extension A and compatibility) plus the Japanese kana, the scripts the snap
// layer treats as CJK. Latin/other scripts are intentionally excluded so non-CJK selections never snap.
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

// Whether `text` contains a CJK character, used to gate snapping to CJK words only.
export function isCjkText(text: string): boolean {
  return CJK_PATTERN.test(text);
}

// The word-like segment of `text` that contains the character `offset`, via the platform
// `Intl.Segmenter` (dictionary-based word segmentation, no bundle weight). Returns undefined when the
// segmenter is unavailable (older engine), the offset falls outside any word, or the containing
// segment is not word-like (whitespace/punctuation) — the caller then keeps the raw selection.
export function segmentWordAt(text: string, offset: number, locale: string): WordSpan | undefined {
  if (!("Segmenter" in Intl)) {
    return undefined;
  }

  const segmenter = new Intl.Segmenter(locale, { granularity: "word" });

  for (const segment of segmenter.segment(text)) {
    const start = segment.index;
    const end = start + segment.segment.length;

    if (offset >= start && offset < end) {
      return segment.isWordLike === true ? { end, start, text: segment.segment } : undefined;
    }
  }

  return undefined;
}
