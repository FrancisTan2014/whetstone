import type { BlockDto, ReadingUnitDto, WorkContentDto } from "@whetstone/contracts";

// The reader's view of a work: reading units and blocks placed in reading order, each carrying
// its stored mdast for direct (re-parse-free) rendering. Building this pure model keeps ordering
// out of the React component.
export type ReaderBlock = Readonly<{
  entryId: string;
  isHeading: boolean;
  mdast: unknown;
  plaintext: string;
}>;

export type ReaderUnit = Readonly<{
  blocks: ReadonlyArray<ReaderBlock>;
  entryId: string;
  title?: string;
}>;

export type ReaderView = Readonly<{
  units: ReadonlyArray<ReaderUnit>;
  workEntryId: string;
}>;

function byOrderIndex(first: { orderIndex: number }, second: { orderIndex: number }): number {
  return first.orderIndex - second.orderIndex;
}

function toReaderBlock(block: BlockDto): ReaderBlock {
  return {
    entryId: block.entryId,
    isHeading: block.blockType === "heading",
    mdast: block.mdast,
    plaintext: block.plaintext
  };
}

function toReaderUnit(unit: ReadingUnitDto): ReaderUnit {
  const blocks = [...unit.blocks].sort(byOrderIndex).map(toReaderBlock);
  const base = { blocks, entryId: unit.entryId };

  return unit.title === undefined ? base : { ...base, title: unit.title };
}

export function buildReaderView(content: WorkContentDto): ReaderView {
  return {
    units: [...content.readingUnits].sort(byOrderIndex).map(toReaderUnit),
    workEntryId: content.workEntryId
  };
}
