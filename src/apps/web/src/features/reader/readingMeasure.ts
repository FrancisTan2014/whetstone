// The reading column's max width, in a **font-size-independent** unit (rem). The text-size
// control scales `--reading-size`, but the column width must not track it: a `ch`/`em` measure
// (the old `66ch`/`38em`) widened the column as the text grew, instead of reflowing the text
// within a stable column. A rem measure keeps the left/right edges put while A+/A− only changes
// the text size. CJK text runs a little wider than the Latin baseline.
//
// Desktop composition (#180): the column is substantial (≈44rem Latin, ≤ ~75 Latin chars/line) so
// it does not read as a thin strip adrift in whitespace, and the tool rail docks just outside this
// width — never full-width, and below WeRead's CJK-justified ~820px (~51rem).
const latinMeasureRem = "44rem";
const cjkMeasureRem = "46rem";

// CJK reading languages (v0: zh-CN / zh-TW) get the wider measure; everything else uses Latin.
export function readingMeasureRem(language: string): string {
  return language.startsWith("zh") ? cjkMeasureRem : latinMeasureRem;
}
