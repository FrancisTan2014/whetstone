import { firstSubstantiveUnitIndex } from "./readerNavigation";
import type { ReaderStructure } from "./readerModel";

export type FrontMatterNoticeProps = Readonly<{
  activeUnitIndex: number;
  onSelectUnit: (index: number) => void;
  structure: ReaderStructure;
}>;

// Shown when the reader is on a front-matter-like unit (a cover/plate with no substantive text) and a
// substantive unit exists elsewhere in the work (#394). It labels the unit as front matter, de-emphasized,
// and offers a single "Start reading" affordance that jumps to the first substantive unit — so front
// matter stays reachable (via TOC/pager/deep link) without trapping the reader there. Renders nothing on
// a substantive unit, or when no substantive unit can be identified (every unit is front matter).
export function FrontMatterNotice({
  activeUnitIndex,
  onSelectUnit,
  structure
}: FrontMatterNoticeProps): React.JSX.Element | null {
  const active = structure.units[activeUnitIndex];

  if (active === undefined || active.hasSubstantiveText) {
    return null;
  }

  const target = firstSubstantiveUnitIndex(structure);

  if (target === undefined || target === activeUnitIndex) {
    return null;
  }

  return (
    <aside aria-label="Front matter" className="readerFrontMatterNotice">
      <p className="readerFrontMatterNoticeLabel">Front matter</p>
      <button
        className="readerFrontMatterNoticeStart"
        onClick={() => onSelectUnit(target)}
        type="button"
      >
        Start reading →
      </button>
    </aside>
  );
}
