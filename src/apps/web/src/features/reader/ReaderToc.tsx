export type ReaderTocItem = Readonly<{ entryId: string; label: string }>;

// One authored nav entry in the tree view (#379): its label, its authored nesting `depth` (used to
// indent it), and a self-contained `onSelect` thunk (so the drawer never re-derives navigation and a
// miss can never leak into render). Rendered fully expanded, in pre-order.
export type ReaderTocTreeItem = Readonly<{
  depth: number;
  entryId: string;
  label: string;
  onSelect: () => void;
}>;

// The 目录 renders one of two shapes. `list` is the spine-driven reading-unit list (the fallback for a
// work with no authored nav — Markdown or a nav-less EPUB): a flat list keyed on the active index.
// `tree` is the authored nav-derived table of contents (#379): the authored labels indented by depth,
// the current entry highlighted, each entry carrying its own navigation thunk.
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

// The 目录 (table of contents): a controlled, dismissable drawer at every width — its open state lives
// in the reader so the toggle recedes with the rest of the reading tools (ReadingHeader). The drawer
// renders over a backdrop; selecting an entry (or tapping the backdrop / close control) closes it, so
// the immersive reading column is never split by a persistent sidebar. When the work has an authored
// nav (`mode: "tree"`) it shows that hierarchy of authored labels; otherwise it lists the reading
// units (`mode: "list"`) so a nav-less work still navigates chapter by chapter.
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
        <ul className="readerTocList">
          {props.mode === "list"
            ? props.items.map((item, index) => (
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
              ))
            : props.entries.map((entry) => (
                <li key={entry.entryId}>
                  <button
                    aria-current={entry.entryId === props.activeEntryId ? "true" : undefined}
                    className="readerTocItem readerTocEntry"
                    data-depth={entry.depth}
                    onClick={() => {
                      entry.onSelect();
                      onClose();
                    }}
                    style={{ "--toc-depth": entry.depth } as React.CSSProperties}
                    type="button"
                  >
                    {entry.label}
                  </button>
                </li>
              ))}
        </ul>
      </nav>
    </div>
  );
}
