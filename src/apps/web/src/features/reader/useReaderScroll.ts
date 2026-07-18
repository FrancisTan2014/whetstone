import { useEffect, useState } from "react";

// Scroll-derived reader chrome state: whether the reading header should auto-hide (it
// hides while scrolling down past a small threshold and reappears on scroll up) and the
// reading progress through the document (0..1).
export type ReaderScroll = Readonly<{
  headerHidden: boolean;
  progress: number;
}>;

const hideThreshold = 80;

function readProgress(element: HTMLElement): number {
  const max = element.scrollHeight - element.clientHeight;

  if (max <= 0) {
    return 0;
  }

  return Math.min(1, Math.max(0, element.scrollTop / max));
}

// Observes the reader's own scroll container rather than the window. The reader is framed inside
// the app shell (whose `.app-safe-area` is `100dvh; overflow: hidden`, so the window never
// scrolls); the reading column scrolls inside an inner element instead. The caller passes that
// element once it mounts (null while the reader is not in its reading state). While it is null the
// hook holds the neutral state and attaches nothing; once an element arrives, progress/hide state
// derive from it (an immediate read seeds the initial values).
export function useReaderScroll(element: HTMLElement | null): ReaderScroll {
  const [scroll, setScroll] = useState<ReaderScroll>({ headerHidden: false, progress: 0 });

  useEffect(() => {
    if (element === null) {
      return;
    }

    const el = element;
    let lastY = el.scrollTop;

    function onScroll(): void {
      const y = el.scrollTop;
      const headerHidden = y > lastY && y > hideThreshold;
      lastY = y;
      setScroll({ headerHidden, progress: readProgress(el) });
    }

    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      el.removeEventListener("scroll", onScroll);
    };
  }, [element]);

  return scroll;
}
