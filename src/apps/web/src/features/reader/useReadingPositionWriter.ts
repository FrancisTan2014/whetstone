import { useEffect } from "react";

import { topmostVisibleBlockId } from "./readingAnchor";
import type { ReadingPosition } from "./readingPosition";

// Scroll writes are debounced so scrolling does not flood the server.
export const positionWriteDelayMs = 300;

export type ReadingPositionTarget = Readonly<{ unitEntryId: string; workEntryId: string }>;

// Persists the reader's position to the server for the open work. `save` is injected so this is
// exercised with a fake save and fake timers (the real one calls `saveReadingPosition`).
export type SaveReadingPosition = (workEntryId: string, position: ReadingPosition) => void;

// Saves the reader's position to the server for the open work: it writes once when the work/unit
// becomes active (so a unit switch is recorded immediately) and again, debounced, as the reader
// scrolls — each write captures the current unit and the topmost visible block. Idle/loading
// states (no target) write nothing. `shouldWrite` gates every write so the caller can suppress
// saves while a restore/deep-link scroll is still pending — otherwise the immediate save would
// capture the pre-scroll top-of-unit block and overwrite the saved anchor before it is applied.
export function useReadingPositionWriter(
  save: SaveReadingPosition,
  target: ReadingPositionTarget | undefined,
  shouldWrite: () => boolean
): void {
  const unitEntryId = target?.unitEntryId;
  const workEntryId = target?.workEntryId;

  useEffect(() => {
    if (workEntryId === undefined || unitEntryId === undefined) {
      return;
    }

    const work = workEntryId;
    const unit = unitEntryId;

    function writePosition(): void {
      if (!shouldWrite()) {
        return;
      }

      const anchorBlockEntryId = topmostVisibleBlockId();
      save(work, {
        unitEntryId: unit,
        ...(anchorBlockEntryId === undefined ? {} : { anchorBlockEntryId })
      });
    }

    writePosition();

    let timer: number | undefined;

    function onScroll(): void {
      window.clearTimeout(timer);
      timer = window.setTimeout(writePosition, positionWriteDelayMs);
    }

    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
    };
  }, [save, shouldWrite, unitEntryId, workEntryId]);
}
