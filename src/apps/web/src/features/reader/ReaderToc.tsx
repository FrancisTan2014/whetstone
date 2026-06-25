import { useState } from "react";

export type ReaderTocItem = Readonly<{ entryId: string; label: string }>;

export type ReaderTocProps = Readonly<{
  activeIndex: number;
  items: ReadonlyArray<ReaderTocItem>;
  onSelect: (index: number) => void;
}>;

// The 目录 (table of contents): lists a work's reading units in order with the current one
// marked, so the reader moves chapter by chapter instead of scrolling a whole book. It is a
// dismissable drawer at every width — the toggle opens it over a backdrop so the immersive
// reading column is never split by a persistent sidebar. Selecting a unit opens it and closes
// the drawer.
export function ReaderToc({ activeIndex, items, onSelect }: ReaderTocProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  function select(index: number): void {
    onSelect(index);
    setOpen(false);
  }

  return (
    <div className={open ? "readerToc readerToc--open" : "readerToc"}>
      <button
        aria-controls="reader-toc-list"
        aria-expanded={open}
        className="readerTocToggle"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        目录
      </button>
      {open ? (
        <button
          aria-label="Close table of contents"
          className="readerTocBackdrop"
          onClick={() => setOpen(false)}
          type="button"
        />
      ) : null}
      <nav aria-label="目录" className="readerTocNav" id="reader-toc-list">
        <p className="readerTocHeading">目录</p>
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
