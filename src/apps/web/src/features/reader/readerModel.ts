import type {
  BlockDto,
  ReadingUnitContentDto,
  ReadingUnitStructureDto,
  WorkStructureDto
} from "@whetstone/contracts";

// The reader's view of a work: a lightweight structure (reading units + block counts) loaded
// first, then each active unit's blocks fetched on demand and placed in reading order, each
// block carrying its stored mdast for direct (re-parse-free) rendering. Building these pure
// models keeps ordering out of the React component. Figure blocks additionally carry their
// stored image id + alt so the reader can render `<figure>` from `/api/images/:id`; both are
// absent on non-figure blocks.
export type ReaderBlock = Readonly<{
  alt?: string;
  anchorId?: string;
  blockType: BlockDto["blockType"];
  entryId: string;
  imageResourceId?: string;
  isHeading: boolean;
  mdast: unknown;
  plaintext: string;
}>;

// A loaded reading unit: its ordered blocks plus the title used for the eyebrow.
export type ReaderUnit = Readonly<{
  blocks: ReadonlyArray<ReaderBlock>;
  entryId: string;
  title?: string;
}>;

// One reading unit in the lightweight structure: ordering metadata and how many blocks it
// holds, but no content — enough to render the 目录 and decide which unit to open.
export type ReaderUnitMeta = Readonly<{
  blockCount: number;
  entryId: string;
  orderIndex: number;
  title?: string;
}>;

// The work's structure: ordered unit metadata, fetched before any unit's blocks.
export type ReaderStructure = Readonly<{
  units: ReadonlyArray<ReaderUnitMeta>;
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
  const withAlt = block.alt === undefined ? withImage : { ...withImage, alt: block.alt };

  return block.anchorId === undefined ? withAlt : { ...withAlt, anchorId: block.anchorId };
}

function toReaderUnitMeta(unit: ReadingUnitStructureDto): ReaderUnitMeta {
  const base = { blockCount: unit.blockCount, entryId: unit.entryId, orderIndex: unit.orderIndex };

  return unit.title === undefined ? base : { ...base, title: unit.title };
}

// The reader structure built from a work's structure DTO: units sorted into reading order so
// the 目录 and navigation read positionally without trusting the array order.
export function buildReaderStructure(structure: WorkStructureDto): ReaderStructure {
  return {
    units: [...structure.readingUnits].sort(byOrderIndex).map(toReaderUnitMeta),
    workEntryId: structure.workEntryId
  };
}

// The ordered blocks of a fetched reading unit, ready to render in reading order.
export function toReaderBlocks(unit: ReadingUnitContentDto): ReadonlyArray<ReaderBlock> {
  return [...unit.blocks].sort(byOrderIndex).map(toReaderBlock);
}
