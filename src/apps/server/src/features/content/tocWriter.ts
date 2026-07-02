import type { EntryId } from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import { entries, tocEntries } from "../../db/schema.js";
import type { NavEntry } from "../../files/epubNav.js";
import { insertInBatches } from "./insertBatching.js";
import { resolveRelativeHref } from "./resolveRelativeHref.js";

type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// One flattened nav entry ready to persist as a `toc_entries` row (#379). `entryId` is the entry's
// stable id (also its `entries` id), `parentEntryId` the id of the enclosing entry (null at the root),
// `orderIndex` a work-global pre-order rank (so serving in this order yields the tree fully expanded),
// and `depth` the authored nesting level. `targetSourceFile` is the entry href resolved against the
// nav document to a spine source-file identity (null for a label-only/structural entry), and
// `targetAnchor` the href's `#fragment` (null when the entry targets a whole file).
export type TocEntryRow = Readonly<{
  depth: number;
  entryId: string;
  label: string;
  orderIndex: number;
  parentEntryId: string | null;
  targetAnchor: string | null;
  targetSourceFile: string | null;
}>;

export type WriteTocEntriesInput = Readonly<{
  createEntryId: () => string;
  navEntries: ReadonlyArray<NavEntry>;
  // The nav document's own manifest href, the base each entry href is resolved relative to (#366).
  navPath: string;
  workEntryId: EntryId;
}>;

// Split a nav entry's raw href into the spine source-file it targets and the `#fragment` (anchor)
// within it. The path part is resolved relative to the nav document (`navPath`) so a `../` or `./`
// href yields a path comparable to a reading unit's `source_file` (#366); `resolveRelativeHref`
// strips the query/fragment for the path. A href with no path part — a bare `#fragment` or an empty
// href (a label-only structural node) — has no source file, so it stays unresolved (null) and its
// selection later no-ops. An empty fragment (`file#`) is treated as no anchor.
function resolveTarget(
  navPath: string,
  href: string
): Readonly<{ targetAnchor: string | null; targetSourceFile: string | null }> {
  const hashIndex = href.indexOf("#");
  const fragment = hashIndex === -1 ? "" : href.slice(hashIndex + 1);
  const pathPart = href.split(/[?#]/)[0] as string;

  return {
    targetAnchor: fragment === "" ? null : fragment,
    targetSourceFile: pathPart === "" ? null : resolveRelativeHref(navPath, href)
  };
}

// Flatten the parsed nav tree into ordered, addressable rows (#379). A pre-order walk preserves the
// authored hierarchy (`depth` + `parentEntryId`) and sibling order, assigning each entry a fresh id
// and a work-global monotonic `orderIndex` so the whole tree has a single total order the reader can
// render fully expanded. Pure: no DB, no id source beyond the injected `createEntryId`, so the
// nav → target mapping tests in isolation.
export function flattenNavTree(
  navEntries: ReadonlyArray<NavEntry>,
  navPath: string,
  createEntryId: () => string
): ReadonlyArray<TocEntryRow> {
  const rows: TocEntryRow[] = [];
  let orderIndex = 0;

  const walk = (nodes: ReadonlyArray<NavEntry>, depth: number, parentEntryId: string | null): void => {
    for (const node of nodes) {
      const entryId = createEntryId();
      const { targetAnchor, targetSourceFile } = resolveTarget(navPath, node.href);

      rows.push({
        depth,
        entryId,
        label: node.label,
        orderIndex,
        parentEntryId,
        targetAnchor,
        targetSourceFile
      });
      orderIndex += 1;

      walk(node.children, depth + 1, entryId);
    }
  };

  walk(navEntries, 0, null);

  return rows;
}

// Persist a work's authored nav tree as `toc_entries` rows (#379), each also registered as a
// first-class `entries` row (mirroring how reading units register entries) so a toc entry is
// addressable. Called inside the ingest transaction after reading units are written. Fail-soft: a
// work with no nav entries persists nothing (no rows, no throw). Batched like the block writer so a
// large nav never exceeds the bind-parameter ceiling.
export async function writeTocEntries(tx: Transaction, input: WriteTocEntriesInput): Promise<void> {
  const rows = flattenNavTree(input.navEntries, input.navPath, input.createEntryId);

  if (rows.length === 0) {
    return;
  }

  const entryRows = rows.map((row) => ({ id: row.entryId, type: "toc_entry" as const }));
  const tocRows = rows.map((row) => ({
    depth: row.depth,
    entryId: row.entryId,
    label: row.label,
    orderIndex: row.orderIndex,
    parentEntryId: row.parentEntryId,
    targetAnchor: row.targetAnchor,
    targetSourceFile: row.targetSourceFile,
    workEntryId: input.workEntryId
  }));

  await insertInBatches(entryRows, (batch) => tx.insert(entries).values(batch));
  await insertInBatches(tocRows, (batch) => tx.insert(tocEntries).values(batch));
}
