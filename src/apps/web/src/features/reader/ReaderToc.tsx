import { useState } from "react";

export type ReaderTocItem = Readonly<{ entryId: string; label: string }>;

export type ReaderTocProps = Readonly<{
  activeIndex: number;
  items: ReadonlyArray<ReaderTocItem>;
  onSelect: (index: number) => void;
}>;

// The 目录 (table of contents): lists a work's reading units in order with the current one
// marked, so the reader moves chapter by chapter instead of scrolling a whole book. It is a
// persistent sidebar on desktop/tablet and a collapsible drawer on mobile (CSS hides the
// toggle on wide screens, where the list is always shown). Selecting a unit opens it and
// closes the mobile drawer.
export function ReaderToc({ activeIndex, items, onSelect }: ReaderTocProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  function select(index: number): void {
    onSelect(index);
    setOpen(false);
  }

  return (
    <div className="readerToc">
      <button
        aria-controls="reader-toc-list"
        aria-expanded={open}
        className="readerTocToggle"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        目录
      </button>
      <nav
        aria-label="目录"
        className={open ? "readerTocNav readerTocNav--open" : "readerTocNav"}
        id="reader-toc-list"
      >
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
