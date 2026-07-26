// The pure block change-set diff for an editable-Work save (#762). A correction (or any editable-Work
// save) substitutes a draft block stream over an affected span; to record precise correction evidence the
// caller needs to know exactly which blocks were inserted, had their content changed, were removed, or were
// only reordered. This module owns ONLY that set/order arithmetic over stable block ids and opaque content
// keys — no ProseMirror, database, or marker detail — so every arm is testable without a database.
//
// Each block is identified by its stable id and an opaque `contentKey`: any stable serialization the caller
// chooses (e.g. the canonical JSON of the block's node) such that two blocks compare equal iff their
// rendered content is identical. Ids are unique within each sequence (a Work never repeats a block id).

// One block of an ordered stream: its stable id and an opaque content key that changes iff the block's
// content changes.
export type BlockSequenceEntry = Readonly<{ contentKey: string; id: string }>;

// The precise result of substituting `after` for `before` over the same span. Every surviving block falls
// into exactly ONE of `changed` (content differs) or `moved` (content identical but its position relative
// to the other surviving blocks changed) or neither (untouched); a block present on only one side is
// `inserted` or `removed`. The sets are therefore disjoint, so `corrected_at`-style marking of the
// changed/inserted blocks never double-counts a mere reorder.
export type BlockChangeSet = Readonly<{
  changed: readonly string[];
  inserted: readonly string[];
  moved: readonly string[];
  removed: readonly string[];
}>;

// True when a save made no content, structural, or ordering change at all — every block survived unmoved
// with identical content. A no-op save may still advance the Work revision, but it must not stamp any
// correction marker (#762), so the caller consults this before marking.
export function isEmptyBlockChangeSet(changeSet: BlockChangeSet): boolean {
  return (
    changeSet.inserted.length === 0 &&
    changeSet.changed.length === 0 &&
    changeSet.removed.length === 0 &&
    changeSet.moved.length === 0
  );
}

// Classify how the `after` stream differs from the `before` stream. `removed` is reported in before-order;
// `inserted`, `changed`, and `moved` are reported in after-order. A surviving block is `changed` when its
// content key differs; otherwise it is `moved` when its rank among the surviving blocks changed; otherwise
// it is untouched. Reordering is measured over the surviving blocks only, so an insertion or deletion that
// merely shifts absolute positions is never mistaken for a move.
export function diffBlockSequences(
  before: readonly BlockSequenceEntry[],
  after: readonly BlockSequenceEntry[]
): BlockChangeSet {
  const beforeById = new Map(before.map((entry) => [entry.id, entry.contentKey]));
  const afterById = new Map(after.map((entry) => [entry.id, entry.contentKey]));

  const removed = before.filter((entry) => !afterById.has(entry.id)).map((entry) => entry.id);
  const inserted = after.filter((entry) => !beforeById.has(entry.id)).map((entry) => entry.id);

  // The surviving blocks in each stream's order, so a block's rank among survivors can be compared.
  const survivingBeforeRank = new Map<string, number>();
  before
    .filter((entry) => afterById.has(entry.id))
    .forEach((entry, rank) => survivingBeforeRank.set(entry.id, rank));

  const changed: string[] = [];
  const moved: string[] = [];
  after
    .filter((entry) => beforeById.has(entry.id))
    .forEach((entry, afterRank) => {
      if (beforeById.get(entry.id) !== entry.contentKey) {
        changed.push(entry.id);
      } else if (survivingBeforeRank.get(entry.id) !== afterRank) {
        moved.push(entry.id);
      }
    });

  return { changed, inserted, moved, removed };
}
