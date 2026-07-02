import { useMemo, useState } from "react";

export type ReaderTocItem = Readonly<{ entryId: string; label: string }>;

// One authored nav entry in the collapsible tree view (#379 data, #380 UX): its label, its authored
// nesting `depth` (used to indent it), the `parentEntryId` that reconstructs the hierarchy (absent for
// a root entry), and a self-contained `onSelect` thunk (so the drawer never re-derives navigation and a
// miss can never leak into render). The flat array arrives in pre-order; the drawer rebuilds the tree
// and shows it collapsible, auto-expanding the active entry's ancestors.
export type ReaderTocTreeItem = Readonly<{
  depth: number;
  entryId: string;
  label: string;
  onSelect: () => void;
  parentEntryId?: string;
}>;

// The 目录 renders one of two shapes. `list` is the spine-driven reading-unit list (the fallback for a
// work with no authored nav — Markdown or a nav-less EPUB): a flat list keyed on the active index.
// `tree` is the authored nav-derived table of contents (#379): the authored labels indented by depth,
// the current entry highlighted, each entry carrying its own navigation thunk. In tree mode the drawer
// is a collapsible hierarchy (#380): a parent carries a disclosure control and hides its descendants
// when collapsed; the active entry's ancestors open on load so a long book opens compact around it.
type ReaderTocListModel = Readonly<{
  activeIndex: number;
  items: ReadonlyArray<ReaderTocItem>;
  mode: "list";
  onSelect: (index: number) => void;
}>;

type ReaderTocTreeModel = Readonly<{
  activeEntryId?: string;
  entries: ReadonlyArray<ReaderTocTreeItem>;
  mode: "tree";
}>;

export type ReaderTocProps = Readonly<{ onClose: () => void; open: boolean }> &
  (ReaderTocListModel | ReaderTocTreeModel);

// One node of the reconstructed authored tree: the flat entry plus its ordered children, so the drawer
// renders (and collapses) the hierarchy without re-reading the flat array during render.
type ReaderTocTreeNode = Readonly<{
  children: ReadonlyArray<ReaderTocTreeNode>;
  entry: ReaderTocTreeItem;
}>;

// Rebuild the parent→children tree from the flat pre-order entries: roots (no `parentEntryId`) seed the
// top level, every other entry is bucketed under its parent in arrival order, then each node pulls its
// bucket recursively. The input order is preserved, so the tree renders in the authored pre-order.
function buildTocTree(entries: ReadonlyArray<ReaderTocTreeItem>): ReadonlyArray<ReaderTocTreeNode> {
  const childrenByParent = new Map<string, ReaderTocTreeItem[]>();
  const roots: ReaderTocTreeItem[] = [];

  for (const entry of entries) {
    if (entry.parentEntryId === undefined) {
      roots.push(entry);
      continue;
    }

    const bucket = childrenByParent.get(entry.parentEntryId);
    if (bucket === undefined) {
      childrenByParent.set(entry.parentEntryId, [entry]);
    } else {
      bucket.push(entry);
    }
  }

  const build = (entry: ReaderTocTreeItem): ReaderTocTreeNode => ({
    children: (childrenByParent.get(entry.entryId) ?? []).map(build),
    entry
  });

  return roots.map(build);
}

// The ids of every ancestor of the active entry (walking `parentEntryId` up to a root). These are the
// parents the drawer opens on load so the active entry is visible; the active entry itself stays
// collapsed, keeping a long book compact around where the reader is.
function ancestorIds(
  entries: ReadonlyArray<ReaderTocTreeItem>,
  activeEntryId: string | undefined
): ReadonlySet<string> {
  const parentOf = new Map<string, string>();
  for (const entry of entries) {
    if (entry.parentEntryId !== undefined) {
      parentOf.set(entry.entryId, entry.parentEntryId);
    }
  }

  const ids = new Set<string>();
  let current = activeEntryId;
  while (current !== undefined) {
    const parentId = parentOf.get(current);
    if (parentId !== undefined) {
      ids.add(parentId);
    }
    current = parentId;
  }

  return ids;
}

// The collapsible authored tree (#380). Expand/collapse is local UI state (not persisted in v0),
// seeded from the active entry's ancestor path so the drawer opens compact around the reader's place.
// The caller re-seeds this by remounting (a `key` on the active entry, and the whole subtree unmounts
// while the drawer is closed), so a fresh open — or the active entry moving to another branch — reopens
// on the new path, while a reader's own toggles in between are left untouched.
function ReaderTocTree({
  activeEntryId,
  entries,
  onClose
}: {
  activeEntryId: string | undefined;
  entries: ReadonlyArray<ReaderTocTreeItem>;
  onClose: () => void;
}): React.JSX.Element {
  const nodes = useMemo(() => buildTocTree(entries), [entries]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() =>
    ancestorIds(entries, activeEntryId)
  );

  const toggle = (entryId: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entryId)) {
        next.delete(entryId);
      } else {
        next.add(entryId);
      }
      return next;
    });
  };

  const renderNode = (node: ReaderTocTreeNode): React.JSX.Element => {
    const { children, entry } = node;
    const hasChildren = children.length > 0;
    const isOpen = expanded.has(entry.entryId);

    return (
      <li
        className="readerTocNode"
        data-depth={entry.depth}
        key={entry.entryId}
        style={{ "--toc-depth": entry.depth } as React.CSSProperties}
      >
        <div className="readerTocRow">
          {hasChildren ? (
            <button
              aria-expanded={isOpen}
              aria-label={`${isOpen ? "Collapse" : "Expand"} ${entry.label}`}
              className="readerTocDisclosure"
              onClick={() => toggle(entry.entryId)}
              type="button"
            >
              <span aria-hidden className="readerTocCaret">
                ▾
              </span>
            </button>
          ) : (
            <span aria-hidden className="readerTocDisclosureSpacer" />
          )}
          <button
            aria-current={entry.entryId === activeEntryId ? "true" : undefined}
            className="readerTocItem readerTocEntry"
            onClick={() => {
              entry.onSelect();
              onClose();
            }}
            type="button"
          >
            {entry.label}
          </button>
        </div>
        {hasChildren && isOpen ? (
          <ul className="readerTocList readerTocSubList">{children.map(renderNode)}</ul>
        ) : null}
      </li>
    );
  };

  return <ul className="readerTocList readerTocTree">{nodes.map(renderNode)}</ul>;
}

// The 目录 (table of contents): a controlled, dismissable drawer at every width — its open state lives
// in the reader so the toggle recedes with the rest of the reading tools (ReadingHeader). The drawer
// renders over a backdrop; selecting an entry (or tapping the backdrop / close control) closes it, so
// the immersive reading column is never split by a persistent sidebar. When the work has an authored
// nav (`mode: "tree"`) it shows that hierarchy as a collapsible tree with an auto-expanded active path
// (#380); otherwise it lists the reading units (`mode: "list"`) so a nav-less work still navigates
// chapter by chapter.
export function ReaderToc(props: ReaderTocProps): React.JSX.Element | null {
  if (!props.open) {
    return null;
  }

  const { onClose } = props;

  return (
    <div className="readerToc readerToc--open">
      <button
        aria-label="Close table of contents"
        className="readerTocBackdrop"
        onClick={onClose}
        type="button"
      />
      <nav aria-labelledby="reader-toc-heading" className="readerTocNav" id="reader-toc-list">
        <p className="readerTocHeading" id="reader-toc-heading">
          Table of Contents
        </p>
        {props.mode === "list" ? (
          <ul className="readerTocList">
            {props.items.map((item, index) => (
              <li key={item.entryId}>
                <button
                  aria-current={index === props.activeIndex ? "true" : undefined}
                  className="readerTocItem"
                  onClick={() => {
                    props.onSelect(index);
                    onClose();
                  }}
                  type="button"
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <ReaderTocTree
            activeEntryId={props.activeEntryId}
            entries={props.entries}
            key={props.activeEntryId ?? ""}
            onClose={onClose}
          />
        )}
      </nav>
    </div>
  );
}
