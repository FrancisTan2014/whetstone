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

// A contents/list glyph for the 目录 control (labelled by the button's aria-label, so the icon
// itself is decorative). Replaces the literal "目录" text per the WeRead-style chrome.
function ContentsIcon(): React.JSX.Element {
  return (
    <svg aria-hidden className="readingToolIcon" fill="none" viewBox="0 0 24 24">
      <path
        d="M8 6h12M8 12h12M8 18h12M3.5 6h.01M3.5 12h.01M3.5 18h.01"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function NotesIcon(): React.JSX.Element {
  return (
    <svg aria-hidden className="readingToolIcon" fill="none" viewBox="0 0 24 24">
      <path
        d="M6 3.5h9l4 4V20a.5.5 0 0 1-.5.5h-12A.5.5 0 0 1 6 20V4a.5.5 0 0 1 .5-.5zM14.5 3.5V8h4.5M9 13h6M9 16.5h4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

// The immersive reading chrome: every reading tool in one receding surface — text size (A−/A+),
// the Day/Night theme toggle, the 目录 (when the work has units, shown as a contents icon), a notes
// toggle, and a progress indicator. On desktop the tools sit in a right-edge vertical icon rail and
// the title is a minimal top affordance; on narrow screens they form a top bar. The whole chrome
// recedes while reading (`hidden` → `data-hidden`) and returns on hover / scroll-up (desktop) or a
// center tap (mobile); the single `data-hidden` flag drives the CSS transition so every tool recedes
// together. Tool labels stay on `aria-label`, so the controls are screen-reader clear even as icons.
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
      {/* A thin right-edge hover zone so the receded desktop rail returns on hover (CSS only). */}
      <span aria-hidden className="readingRailEdge" />
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
            <ContentsIcon />
          </Button>
        ) : null}
        <Button
          aria-expanded={notesOpen}
          aria-label="Your notes"
          onClick={onToggleNotes}
          size="sm"
          variant="ghost"
        >
          <NotesIcon />
          {notesCount > 0 ? <span className="readingToolBadge">{notesCount}</span> : null}
        </Button>
      </div>
    </header>
  );
}
