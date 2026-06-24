import { useEffect } from "react";

import type { PositionStore } from "./readingPosition";

// Writes are throttled so scrolling does not thrash localStorage.
export const positionWriteDelayMs = 300;

export type ReadingPositionTarget = Readonly<{ unitEntryId: string; workEntryId: string }>;

// Persists the reader's position for the open work: it writes once when the work/unit
// becomes active (so a unit switch is recorded immediately) and again, debounced, as the
// reader scrolls. Idle/loading states (no target) write nothing. The store is injected so
// this is exercised with a fake store and fake timers.
export function useReadingPositionWriter(
  store: PositionStore,
  target: ReadingPositionTarget | undefined
): void {
  const unitEntryId = target?.unitEntryId;
  const workEntryId = target?.workEntryId;

  useEffect(() => {
    if (workEntryId === undefined || unitEntryId === undefined) {
      return;
    }

    const work = workEntryId;
    const unit = unitEntryId;
    store.write(work, { scrollOffset: window.scrollY, unitEntryId: unit });

    let timer: number | undefined;

    function onScroll(): void {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        store.write(work, { scrollOffset: window.scrollY, unitEntryId: unit });
      }, positionWriteDelayMs);
    }

    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
    };
  }, [store, unitEntryId, workEntryId]);
}
