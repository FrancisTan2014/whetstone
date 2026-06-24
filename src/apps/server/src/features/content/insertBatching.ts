import type { WorkContentDto } from "@whetstone/contracts";

// PostgreSQL binds each inserted value as one int16-indexed parameter, capping a single
// statement at 32767 parameters. A multi-row INSERT for a large work (e.g. ~5200 blocks ×
// 7 columns ≈ 36400 params) blows past that limit; under PGlite the oversized statement
// aborts and rolls back the whole transaction WITHOUT throwing. Splitting every bulk
// insert into batches that stay well under the limit keeps each statement valid so large
// works persist fully.
const parameterCeiling = 30000;

// Largest row count whose flattened bind-parameter total stays under the ceiling for a row
// of `columnCount` columns. Floored at one row so a (hypothetically) very wide row never
// produces a zero-size batch that would loop forever.
export function batchSize(columnCount: number): number {
  return Math.max(1, Math.floor(parameterCeiling / columnCount));
}

// Insert `rows` in column-aware batches, awaiting each so they all run inside the caller's
// transaction. The column count is read from the row shape, so every table is sized
// correctly without hardcoding per-table widths. Empty input performs no insert.
export async function insertInBatches<Row extends Record<string, unknown>>(
  rows: ReadonlyArray<Row>,
  insertBatch: (batch: Row[]) => Promise<unknown>
): Promise<void> {
  const first = rows[0];

  if (first === undefined) {
    return;
  }

  const size = batchSize(Object.keys(first).length);

  for (let index = 0; index < rows.length; index += size) {
    await insertBatch(rows.slice(index, index + size));
  }
}

// Defense-in-depth: ingestion must never report success when nothing was persisted. If a
// non-empty decomposition (expected blocks > 0) ends up with zero persisted blocks, the
// write silently rolled back, so throw to turn a false 201 into a 5xx instead of returning
// an orphan work with empty content.
export function assertContentPersisted(
  expectedBlockCount: number,
  content: WorkContentDto
): WorkContentDto {
  const persistedBlockCount = content.readingUnits.reduce(
    (total, unit) => total + unit.blocks.length,
    0
  );

  if (expectedBlockCount > 0 && persistedBlockCount === 0) {
    throw new Error(
      "Ingestion persisted no blocks for a non-empty source; the database write was rolled back."
    );
  }

  return content;
}
