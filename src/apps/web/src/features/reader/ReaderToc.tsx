export type ReaderTocItem = Readonly<{ entryId: string; label: string }>;

export type ReaderTocProps = Readonly<{
  activeIndex: number;
  items: ReadonlyArray<ReaderTocItem>;
  onClose: () => void;
  onSelect: (index: number) => void;
  open: boolean;
}>;

// The 目录 (table of contents): lists a work's reading units in order with the current one
// marked, so the reader moves chapter by chapter instead of scrolling a whole book. It is a
// controlled, dismissable drawer at every width — its open state lives in the reader so the
// 目录 toggle recedes with the rest of the reading tools (ReadingHeader). The drawer renders
// over a backdrop; selecting a unit (or tapping the backdrop / close control) closes it, so the
// immersive reading column is never split by a persistent sidebar.
export function ReaderToc({
  activeIndex,
  items,
  onClose,
  onSelect,
  open
}: ReaderTocProps): React.JSX.Element | null {
  if (!open) {
    return null;
  }

  function select(index: number): void {
    onSelect(index);
    onClose();
  }

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
          {items.map((item, index) => (
            <li key={item.entryId}>
              <button
                aria-current={index === activeIndex ? "true" : undefined}
                className="readerTocItem"
                onClick={() => select(index)}
                type="button"
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
