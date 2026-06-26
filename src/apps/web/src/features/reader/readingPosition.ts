import { unitIndexForEntryId } from "./readerNavigation";
import type { ReaderStructure } from "./readerModel";

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

// Resolves a block to its owning reading unit's entry id (via the locator endpoint), or
// undefined when the block is unknown/removed so the deep link simply falls through.
export type LocateBlockUnit = (blockEntryId: string) => Promise<string | undefined>;

// Decide how to open a work. A deep-linked block wins (explicit navigation): its owning unit is
// resolved through the locator endpoint and the reader scrolls to the block; a locator miss (or a
// unit no longer in the structure) falls through. Otherwise a saved position restores its unit and
// scrolls to its block anchor when that unit still exists (no anchor = top of the unit); otherwise
// the first unit opens. A saved unit that no longer exists (the work changed) falls back to the
// first unit; a missing anchor block simply no-ops at scroll time, so a stale anchor never throws.
export async function resolveOpening(
  structure: ReaderStructure,
  options: {
    deepLinkBlockEntryId?: string;
    locateBlockUnit: LocateBlockUnit;
    savedPosition?: ReadingPosition;
  }
): Promise<OpeningPlan> {
  const { deepLinkBlockEntryId, locateBlockUnit, savedPosition } = options;

  if (deepLinkBlockEntryId !== undefined) {
    const unitEntryId = await locateBlockUnit(deepLinkBlockEntryId);

    if (unitEntryId !== undefined) {
      const index = unitIndexForEntryId(structure, unitEntryId);

      if (index !== undefined) {
        return { scrollBlockEntryId: deepLinkBlockEntryId, unitIndex: index };
      }
    }
  }

  if (savedPosition !== undefined) {
    const index = unitIndexForEntryId(structure, savedPosition.unitEntryId);

    if (index !== undefined) {
      return savedPosition.anchorBlockEntryId === undefined
        ? { unitIndex: index }
        : { scrollBlockEntryId: savedPosition.anchorBlockEntryId, unitIndex: index };
    }
  }

  return { unitIndex: 0 };
}
