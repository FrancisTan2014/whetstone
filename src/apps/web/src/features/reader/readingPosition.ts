import { initialUnitIndex } from "./readerNavigation";
import type { ReaderView } from "./readerModel";

// Reading position is client-side UI state (localStorage), never a server source of truth:
// per work, the reader remembers which reading unit was open and a best-effort scroll offset
// within it, so reopening resumes where the reader left off. These helpers are pure (the
// storage is injected) so the compute/restore/serialize logic tests without real layout or
// a real localStorage.

export type ReadingPosition = Readonly<{ scrollOffset: number; unitEntryId: string }>;

// The minimal storage surface the position store needs; satisfied by window.localStorage and
// by a plain fake in tests.
export type PositionStorage = Pick<Storage, "getItem" | "setItem">;

export type PositionStore = Readonly<{
  read: (workEntryId: string) => ReadingPosition | undefined;
  write: (workEntryId: string, position: ReadingPosition) => void;
}>;

// How the reader opens a work: which unit to show, and an optional scroll target — a block
// (a deep link) or a pixel offset (a restored position).
export type OpeningPlan = Readonly<{
  scrollBlockEntryId?: string;
  scrollOffset?: number;
  unitIndex: number;
}>;

const storageKeyPrefix = "whetstone:reading-position:";

export function readingPositionKey(workEntryId: string): string {
  return `${storageKeyPrefix}${workEntryId}`;
}

// Parse a stored value into a ReadingPosition, or undefined when it is missing, not valid
// JSON, or does not match the shape (so corrupt/old storage degrades gracefully).
export function parseReadingPosition(raw: string | null): ReadingPosition | undefined {
  if (raw === null) {
    return undefined;
  }

  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const unitEntryId = record["unitEntryId"];
  const scrollOffset = record["scrollOffset"];

  if (typeof unitEntryId !== "string" || unitEntryId.length === 0) {
    return undefined;
  }

  if (typeof scrollOffset !== "number" || !Number.isFinite(scrollOffset) || scrollOffset < 0) {
    return undefined;
  }

  return { scrollOffset, unitEntryId };
}

export function serializeReadingPosition(position: ReadingPosition): string {
  return JSON.stringify(position);
}

// A position store backed by an injected storage. Reads and writes are best-effort: a
// throwing storage (private mode, quota, disabled) degrades to "no saved position" rather
// than breaking the reader.
export function createLocalStoragePositionStore(storage: PositionStorage): PositionStore {
  return {
    read(workEntryId) {
      try {
        return parseReadingPosition(storage.getItem(readingPositionKey(workEntryId)));
      } catch {
        return undefined;
      }
    },
    write(workEntryId, position) {
      try {
        storage.setItem(readingPositionKey(workEntryId), serializeReadingPosition(position));
      } catch {
        // Best-effort UI state; ignore storage failures.
      }
    }
  };
}

// Decide how to open a work. A deep-linked block wins (explicit navigation); otherwise a
// saved position restores its unit and scroll offset when that unit still exists; otherwise
// the first unit opens. A saved unit that no longer exists (the work changed) falls back to
// the first unit with no offset.
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
      return { scrollOffset: savedPosition.scrollOffset, unitIndex: index };
    }
  }

  return { unitIndex: 0 };
}
