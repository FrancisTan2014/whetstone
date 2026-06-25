import { initialUnitIndex } from "./readerNavigation";
import type { ReaderView } from "./readerModel";

// Reading position is now durable server state (persisted per user + work — see
// `readingPositionApi.ts`), not localStorage UI state: per work, the reader remembers which
// reading unit was open and a best-effort block anchor (the topmost visible block) within it, so
// reopening a work resumes where the reader left off even after a localStorage clear, on a new
// browser, or another device. These helpers stay pure so the resolve logic tests without real
// layout or a server.

export type ReadingPosition = Readonly<{ anchorBlockEntryId?: string; unitEntryId: string }>;

// How the reader opens a work: which unit to show, and an optional block to scroll to. Both a
// deep link and a restored position's anchor reuse the same block-scroll path
// (`scrollBlockEntryId`), so there is no separate pixel-offset restore.
export type OpeningPlan = Readonly<{
  scrollBlockEntryId?: string;
  unitIndex: number;
}>;

// Decide how to open a work. A deep-linked block wins (explicit navigation); otherwise a saved
// position restores its unit and scrolls to its block anchor when that unit still exists (no
// anchor = top of the unit); otherwise the first unit opens. A saved unit that no longer exists
// (the work changed) falls back to the first unit; a missing anchor block simply no-ops at scroll
// time, so a stale anchor never throws.
export function resolveOpening(
  view: ReaderView,
  options: { deepLinkBlockEntryId?: string; savedPosition?: ReadingPosition }
): OpeningPlan {
  const { deepLinkBlockEntryId, savedPosition } = options;

  if (deepLinkBlockEntryId !== undefined) {
    return {
      scrollBlockEntryId: deepLinkBlockEntryId,
      unitIndex: initialUnitIndex(view, deepLinkBlockEntryId)
    };
  }

  if (savedPosition !== undefined) {
    const index = view.units.findIndex((unit) => unit.entryId === savedPosition.unitEntryId);

    if (index !== -1) {
      return savedPosition.anchorBlockEntryId === undefined
        ? { unitIndex: index }
        : { scrollBlockEntryId: savedPosition.anchorBlockEntryId, unitIndex: index };
    }
  }

  return { unitIndex: 0 };
}
