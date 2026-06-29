import type { PersistableReadingUnit } from "./blockWriter.js";

// A clean-step plugin in the ingestion pipeline: a pure `units -> units` transform applied between
// parse/decompose and block-write (epubCommands), so a source can be trimmed before it pollutes the
// library (#275). Each filter is independently toggleable (`enabled`) and unit-tested. Filters are
// pure and format-agnostic — the Markdown path can reuse the same pipeline later.
export type ContentFilter = Readonly<{
  apply: (units: ReadonlyArray<PersistableReadingUnit>) => ReadonlyArray<PersistableReadingUnit>;
  enabled: boolean;
  id: string;
}>;

// Run the enabled filters in order, threading each one's output into the next. No filters (or all
// disabled) is the identity — ingestion is unchanged when nothing is registered.
export function applyContentFilters(
  units: ReadonlyArray<PersistableReadingUnit>,
  filters: ReadonlyArray<ContentFilter>
): ReadonlyArray<PersistableReadingUnit> {
  return filters.reduce(
    (current, filter) => (filter.enabled ? filter.apply(current) : current),
    units
  );
}

// High-confidence markers of publisher front/back matter (preface/colophon/about/contact/QR pages,
// e.g. 7sbook 公版书 editions). Each is a distinctive multi-character phrase or the publisher domain
// that does not occur in real 文言文 chapter prose, so a substring match is conservative: only
// boilerplate units are dropped, never a real chapter. Extend this list to catch new boilerplate.
export const publisherBoilerplateMarkers = [
  "公版书",
  "制作说明",
  "关于我们",
  "联系我们",
  "扫码",
  "7sbook"
] as const;

// A unit is publisher boilerplate when its title or any of its blocks' text carries a marker.
function isPublisherBoilerplate(unit: PersistableReadingUnit): boolean {
  const haystack = [unit.title ?? "", ...unit.blocks.map((block) => block.plaintext)]
    .join("\n")
    .toLowerCase();

  return publisherBoilerplateMarkers.some((marker) => haystack.includes(marker.toLowerCase()));
}

// The first plugin (#275): drop publisher boilerplate units (preface/colophon/about/contact). Drops
// only whole high-confidence units, so the actual work stays intact.
export const dropPublisherBoilerplateFilter: ContentFilter = {
  apply: (units) => units.filter((unit) => !isPublisherBoilerplate(unit)),
  enabled: true,
  id: "drop-publisher-boilerplate"
};

// The registered pipeline, in order — the one place filters are wired into ingestion.
export const defaultContentFilters: ReadonlyArray<ContentFilter> = [dropPublisherBoilerplateFilter];
