import { clampUnitIndex, unitTocLabel } from "./readerNavigation";
import type { ReaderStructure } from "./readerModel";

export type ChapterPagerProps = Readonly<{
  activeUnitIndex: number;
  onSelectUnit: (index: number) => void;
  structure: ReaderStructure;
}>;

// The foot-of-chapter pager (#232): read to the bottom, step to the adjacent unit without opening the
// 目录. Previous is omitted on the first unit, Next on the last, and a single-unit work shows nothing.
// Selecting reuses onSelectUnit (which scrolls to the new chapter's top), clamped defensively.
export function ChapterPager({
  activeUnitIndex,
  onSelectUnit,
  structure
}: ChapterPagerProps): React.JSX.Element | null {
  const units = structure.units;

  if (units.length <= 1) {
    return null;
  }

  const previous = activeUnitIndex > 0 ? units[activeUnitIndex - 1] : undefined;
  const next = activeUnitIndex < units.length - 1 ? units[activeUnitIndex + 1] : undefined;

  return (
    <nav aria-label="Chapter navigation" className="readerPager">
      {previous === undefined ? (
        <span className="readerPagerSpacer" />
      ) : (
        <button
          className="readerPagerLink"
          onClick={() => onSelectUnit(clampUnitIndex(structure, activeUnitIndex - 1))}
          type="button"
        >
          <span className="readerPagerDir">← Previous</span>
          <span className="readerPagerTitle">{unitTocLabel(previous, activeUnitIndex - 1)}</span>
        </button>
      )}
      {next === undefined ? (
        <span className="readerPagerSpacer" />
      ) : (
        <button
          className="readerPagerLink readerPagerLink--next"
          onClick={() => onSelectUnit(clampUnitIndex(structure, activeUnitIndex + 1))}
          type="button"
        >
          <span className="readerPagerDir">Next →</span>
          <span className="readerPagerTitle">{unitTocLabel(next, activeUnitIndex + 1)}</span>
        </button>
      )}
    </nav>
  );
}
