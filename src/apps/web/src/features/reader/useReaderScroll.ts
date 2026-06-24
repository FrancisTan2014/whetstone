import { useEffect, useState } from "react";

// Scroll-derived reader chrome state: whether the reading header should auto-hide (it
// hides while scrolling down past a small threshold and reappears on scroll up) and the
// reading progress through the document (0..1).
export type ReaderScroll = Readonly<{
  headerHidden: boolean;
  progress: number;
}>;

const hideThreshold = 80;

function readProgress(scrollY: number): number {
  const max = document.documentElement.scrollHeight - window.innerHeight;

  if (max <= 0) {
    return 0;
  }

  return Math.min(1, Math.max(0, scrollY / max));
}

export function useReaderScroll(): ReaderScroll {
  const [scroll, setScroll] = useState<ReaderScroll>({ headerHidden: false, progress: 0 });

  useEffect(() => {
    let lastY = window.scrollY;

    function onScroll(): void {
      const y = window.scrollY;
      const headerHidden = y > lastY && y > hideThreshold;
      lastY = y;
      setScroll({ headerHidden, progress: readProgress(y) });
    }

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return scroll;
}
