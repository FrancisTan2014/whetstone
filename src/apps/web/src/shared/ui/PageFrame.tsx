import { ArrowLeft } from "lucide-react";
import { useId } from "react";
import { Link } from "react-router-dom";

import { pageFrameWidthClass, type PageFrameWidth } from "./PageFrame.tokens.js";

// A truthful parent/back treatment (#638, #641): the visible parent label plus a leading ArrowLeft,
// rendered as a real 44px navigation target above the title.
export type PageFrameParentLink = Readonly<{ label: string; to: string }>;

export type PageFrameProps = Readonly<{
  children: React.ReactNode;
  // The optional one-line supporting copy beneath the title (16px/24px muted).
  description?: string;
  // At most one persistent primary header action. It stays a single DOM node placed after the
  // title/description so keyboard focus reaches the heading text before the action on every viewport;
  // CSS alone moves it beside the title on desktop and below it on mobile.
  primaryAction?: React.ReactNode;
  parentLink?: PageFrameParentLink;
  title: string;
  // `focused` (42rem) by default; `collection` (64rem) only for genuine multi-column collections.
  width?: PageFrameWidth;
}>;

// The one shared page-frame boundary (#641). It owns the horizontal gutters, the maximum content width,
// the header rhythm (optional parent link, one 28px/34px semibold H1, optional muted description, and the
// single primary-action slot), and the 24px header→content gap. Feature pages own their content and state
// and never re-declare these shell classes.
//
// Gutters are 16px below 768px and 24px at 768px and up; top spacing is 24px on mobile and 32px on
// desktop (the bottom mirrors the top so content never sits flush against the viewport edge). The frame
// is `w-full` up to its width cap and centered, so both widths are viewport-capped.
//
// Reader is the immersive exception (#641): it keeps its 66ch column and receding chrome and does not use
// this frame, though it adopts the same icon, color, and focus semantics.
export function PageFrame({
  children,
  description,
  parentLink,
  primaryAction,
  title,
  width = "focused"
}: PageFrameProps): React.JSX.Element {
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className={`mx-auto w-full ${pageFrameWidthClass[width]} px-4 pt-6 pb-6 md:px-6 md:pt-8 md:pb-8`}
    >
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-2">
          {parentLink === undefined ? null : (
            <Link
              className="inline-flex min-h-[44px] w-fit items-center gap-1 text-sm font-medium text-text-muted hover:text-text"
              to={parentLink.to}
            >
              <ArrowLeft aria-hidden size={20} strokeWidth={1.75} />
              {parentLink.label}
            </Link>
          )}
          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div className="flex flex-col gap-1">
              <h1
                className="text-[1.75rem] leading-[2.125rem] font-semibold text-text"
                id={headingId}
              >
                {title}
              </h1>
              {description === undefined ? null : (
                <p className="text-base leading-6 text-text-muted">{description}</p>
              )}
            </div>
            {primaryAction === undefined ? null : <div className="shrink-0">{primaryAction}</div>}
          </div>
        </header>
        {children}
      </div>
    </section>
  );
}
