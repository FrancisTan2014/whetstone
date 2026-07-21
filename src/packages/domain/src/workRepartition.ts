// The pure repartition plan for a manual Work (#698). Blocks are the durable content identity;
// ReadingUnits are bounded groupings projected from the ordered block stream. When a manual section is
// saved, its draft blocks are substituted into the Work's logical block stream and the affected contiguous
// span is partitioned at every heading node — the same boundary rule the Outline reads. A surviving
// leading heading keeps its unit's identity; a new leading heading mints a new unit; removing a section's
// leading heading merges its blocks into the preceding unit (the caller extends the span to include it).
//
// This module owns ONLY the identity/containment arithmetic over block ids — no ProseMirror, database, or
// heading-level detail. The caller stamps block ids, decides which blocks are headings, computes the
// affected span, reads the position rows, and writes the result. Keeping the arithmetic pure makes every
// arm — insert, delete, rename, merge, preface, and every position remap — testable without a database.

// One block of the affected stream: its stable id and whether it is a heading node (a partition boundary).
export type RepartitionBlock = Readonly<{ id: string; isHeading: boolean }>;

// An existing reading unit in the affected span, in order, with the ordered ids of the blocks it holds
// today. `blockIds[0]` is the unit's leading block — its identity anchor.
export type RepartitionUnit = Readonly<{ blockIds: readonly string[]; entryId: string }>;

export type RepartitionInput = Readonly<{
  // The existing units in the affected span, in order (the preceding unit first when merging, then the
  // edited unit). Always non-empty.
  affectedUnits: readonly RepartitionUnit[];
  // Mint a fresh reading-unit id for a partition that does not inherit an existing unit's identity.
  mintUnitId: () => string;
  // The affected block stream after substitution, in order and non-empty: the preceding unit's blocks (when
  // merging) followed by the edited section's draft blocks, or just the draft blocks.
  streamBlocks: readonly RepartitionBlock[];
}>;

// One resulting reading unit over the affected span: its id (reused from an existing unit or freshly
// minted), whether it is new, and the ordered block ids it now contains.
export type PlannedUnit = Readonly<{ blockIds: readonly string[]; entryId: string; isNew: boolean }>;

export type RepartitionPlan = Readonly<{
  // Every stream block mapped to the entry id of the resulting unit that now contains it — the anchor a
  // saved reading position follows.
  blockUnitEntryId: ReadonlyMap<string, string>;
  // For a top-of-unit position on a removed unit: the surviving unit it maps to (the nearest surviving
  // unit at the same source location, else the span's first resulting unit).
  removedUnitFallback: ReadonlyMap<string, string>;
  // Existing affected units whose identity was not carried into any resulting unit.
  removedUnitEntryIds: readonly string[];
  // The resulting ordered units over the affected span.
  units: readonly PlannedUnit[];
}>;

// Split the stream into partitions, each beginning at a heading node. The first block always opens the
// first partition (a leading run of non-heading blocks before the first heading is that partition — a
// "Start" the caller only ever produces at the Work's opening).
function partitionStream(streamBlocks: readonly RepartitionBlock[]): string[][] {
  const partitions: string[][] = [];
  streamBlocks.forEach((block, index) => {
    if (index === 0 || block.isHeading) {
      partitions.push([block.id]);
    } else {
      (partitions[partitions.length - 1] as string[]).push(block.id);
    }
  });
  return partitions;
}

// Plan how the edited section's substituted block stream repartitions the affected span into reading units,
// preserving every existing unit id whose leading block still leads a partition and minting a unit for each
// genuinely new heading. Pure: the caller supplies the id generator and applies the returned containment.
export function planSectionRepartition(input: RepartitionInput): RepartitionPlan {
  const partitions = partitionStream(input.streamBlocks);

  // Each existing affected unit's identity, keyed by its current leading block id.
  const identityByLeadBlock = new Map<string, string>();
  for (const unit of input.affectedUnits) {
    identityByLeadBlock.set(unit.blockIds[0] as string, unit.entryId);
  }

  const reusedEntryIds = new Set<string>();
  const units: PlannedUnit[] = partitions.map((blockIds) => {
    const inherited = identityByLeadBlock.get(blockIds[0] as string);
    if (inherited !== undefined && !reusedEntryIds.has(inherited)) {
      reusedEntryIds.add(inherited);
      return { blockIds, entryId: inherited, isNew: false };
    }
    return { blockIds, entryId: input.mintUnitId(), isNew: true };
  });

  const blockUnitEntryId = new Map<string, string>();
  for (const unit of units) {
    for (const blockId of unit.blockIds) {
      blockUnitEntryId.set(blockId, unit.entryId);
    }
  }

  const removedUnitEntryIds = input.affectedUnits
    .map((unit) => unit.entryId)
    .filter((entryId) => !reusedEntryIds.has(entryId));

  // A removed unit's top-of-unit position maps to the unit that now holds its first surviving block (same
  // source location), falling back to the span's first resulting unit when none of its blocks survive.
  const removedUnitFallback = new Map<string, string>();
  const firstUnitEntryId = (units[0] as PlannedUnit).entryId;
  for (const entryId of removedUnitEntryIds) {
    const source = input.affectedUnits.find((unit) => unit.entryId === entryId) as RepartitionUnit;
    const survivingBlock = source.blockIds.find((blockId) => blockUnitEntryId.has(blockId));
    removedUnitFallback.set(
      entryId,
      survivingBlock === undefined
        ? firstUnitEntryId
        : (blockUnitEntryId.get(survivingBlock) as string)
    );
  }

  return { blockUnitEntryId, removedUnitEntryIds, removedUnitFallback, units };
}
