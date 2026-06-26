import type { BlockDto, ReadingUnitDto, WorkContentDto } from "@whetstone/contracts";

// The reader's view of a work: reading units and blocks placed in reading order, each carrying
// its stored mdast for direct (re-parse-free) rendering. Building this pure model keeps ordering
// out of the React component. Figure blocks additionally carry their stored image id + alt so the
// reader can render `<figure>` from `/api/images/:id`; both are absent on non-figure blocks.
export type ReaderBlock = Readonly<{
  alt?: string;
  blockType: BlockDto["blockType"];
  entryId: string;
  imageResourceId?: string;
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
  const base = {
    blockType: block.blockType,
    entryId: block.entryId,
    isHeading: block.blockType === "heading",
    mdast: block.mdast,
    plaintext: block.plaintext
  };
  const withImage =
    block.imageResourceId === undefined
      ? base
      : { ...base, imageResourceId: block.imageResourceId };

  return block.alt === undefined ? withImage : { ...withImage, alt: block.alt };
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
