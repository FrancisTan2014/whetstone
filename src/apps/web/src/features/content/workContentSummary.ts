import type { WorkContentDto } from "@whetstone/contracts";

// A small, pure summary of a work's content so the Work detail header can show counts
// and the ingestion result without the component re-deriving totals inline.
export type WorkContentSummary = Readonly<{
  blockCount: number;
  readingUnitCount: number;
}>;

export function summarizeWorkContent(content: WorkContentDto): WorkContentSummary {
  const blockCount = content.readingUnits.reduce((total, unit) => total + unit.blocks.length, 0);

  return { blockCount, readingUnitCount: content.readingUnits.length };
}

function plural(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

// "2 reading units · 5 blocks" — a compact, human label reused by the header and the
// ingestion result so they always agree.
export function workContentSummaryLabel(summary: WorkContentSummary): string {
  return `${plural(summary.readingUnitCount, "reading unit")} · ${plural(summary.blockCount, "block")}`;
}
