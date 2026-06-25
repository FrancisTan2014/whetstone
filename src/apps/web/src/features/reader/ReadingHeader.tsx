import { Button } from "../../shared/ui/Button";
import { ThemeToggle } from "../../shared/theme/ThemeToggle";
import { largerReadingSize, smallerReadingSize, type ReadingSize } from "./readingSize";

export type ReadingHeaderProps = Readonly<{
  hasToc: boolean;
  hidden: boolean;
  notesCount: number;
  notesOpen: boolean;
  onSizeChange: (size: ReadingSize) => void;
  onToggleNotes: () => void;
  onToggleToc: () => void;
  progress: number;
  size: ReadingSize;
  title: string;
  tocOpen: boolean;
}>;

// The immersive reading tool strip: the work title plus the one place every reading tool lives —
// text-size (A−/A+), the Day/Night theme toggle, the 目录 (when the work has units), a notes
// toggle, and a progress indicator. The whole strip auto-hides while scrolling down (chrome
// recedes while reading) and reappears on scroll up; the `data-hidden` flag drives the single
// CSS transition, so every tool recedes together rather than fighting for attention.
export function ReadingHeader({
  hasToc,
  hidden,
  notesCount,
  notesOpen,
  onSizeChange,
  onToggleNotes,
  onToggleToc,
  progress,
  size,
  title,
  tocOpen
}: ReadingHeaderProps): React.JSX.Element {
  return (
    <header
      className={hidden ? "readingHeader readingHeader--hidden" : "readingHeader"}
      data-hidden={hidden ? "true" : undefined}
    >
      <p className="readingHeaderTitle">{title}</p>
      <div aria-label="Reading tools" className="readingTools" role="group">
        <div aria-label="Reading text size" className="readingSizeControl" role="group">
          <Button
            aria-label="Decrease reading text size"
            onClick={() => onSizeChange(smallerReadingSize(size))}
            size="sm"
            variant="ghost"
          >
            A−
          </Button>
          <Button
            aria-label="Increase reading text size"
            onClick={() => onSizeChange(largerReadingSize(size))}
            size="sm"
            variant="ghost"
          >
            A+
          </Button>
        </div>
        <ThemeToggle />
        {hasToc ? (
          <Button
            aria-controls="reader-toc-list"
            aria-expanded={tocOpen}
            aria-label="Table of contents"
            onClick={onToggleToc}
            size="sm"
            variant="ghost"
          >
            目录
          </Button>
        ) : null}
        <Button
          aria-expanded={notesOpen}
          aria-label="Your notes"
          onClick={onToggleNotes}
          size="sm"
          variant="ghost"
        >
          Notes
          {notesCount > 0 ? <span className="readingToolBadge">{notesCount}</span> : null}
        </Button>
      </div>
      <div
        aria-label="Reading progress"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={Math.round(progress * 100)}
        className="readingProgress"
        role="progressbar"
      >
        <span className="readingProgressBar" style={{ transform: `scaleX(${progress})` }} />
      </div>
    </header>
  );
}
