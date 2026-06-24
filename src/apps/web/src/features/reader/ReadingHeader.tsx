import { Button } from "../../shared/ui/Button";
import { largerReadingSize, smallerReadingSize, type ReadingSize } from "./readingSize";

export type ReadingHeaderProps = Readonly<{
  hidden: boolean;
  onSizeChange: (size: ReadingSize) => void;
  progress: number;
  size: ReadingSize;
  title: string;
}>;

// The immersive reading header: the work title, a reading text-size control, and a
// progress indicator. It auto-hides while scrolling down (chrome recedes while reading)
// and reappears on scroll up; the `data-hidden` flag drives the CSS transition.
export function ReadingHeader({
  hidden,
  onSizeChange,
  progress,
  size,
  title
}: ReadingHeaderProps): React.JSX.Element {
  return (
    <header
      className={hidden ? "readingHeader readingHeader--hidden" : "readingHeader"}
      data-hidden={hidden ? "true" : undefined}
    >
      <p className="readingHeaderTitle">{title}</p>
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
