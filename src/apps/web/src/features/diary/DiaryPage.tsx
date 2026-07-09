import { useEffect, useMemo, useRef, useState } from "react";

import type { DiaryEntryDto, TimelineDayDto } from "@whetstone/contracts";
import {
  groupByDayDesc,
  monthBounds,
  monthGrid,
  shiftMonth,
  toDayKey,
  toMonthKey
} from "@whetstone/domain";

import { Button } from "../../shared/ui/Button.js";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator.js";
import { CaptureCard, type CaptureVoiceDependencies } from "../capture/CaptureCard.js";
import {
  deleteDiaryEntry,
  fetchDiaryCalendar,
  fetchTimeline,
  updateDiaryEntry
} from "./diaryApi.js";

// How many days the Timeline loads per page (matches the server's default page size).
const PAGE_SIZE = 7;

// A timeline entry flattened with the day it falls under, so the pure `groupByDayDesc` can regroup the
// loaded entries (capture prepends, lazy-load appends older) into day sections without another fetch.
export type FlatEntry = Readonly<{
  createdAt: string;
  date: string;
  id: string;
  kind: "diary";
  language: string | null;
  text: string;
}>;

type LoadState = "loading" | "ready" | "error";

function flatten(days: ReadonlyArray<TimelineDayDto>): ReadonlyArray<FlatEntry> {
  return days.flatMap((day) =>
    day.entries.map((entry) => ({
      createdAt: entry.createdAt,
      date: day.date,
      id: entry.id,
      kind: entry.kind,
      language: entry.language,
      text: entry.text
    }))
  );
}

function toFlat(entry: DiaryEntryDto): FlatEntry {
  return {
    createdAt: entry.createdAt,
    date: entry.entryDate,
    id: entry.id,
    kind: "diary",
    language: entry.language,
    text: entry.text
  };
}

// The calendar day whose mark should be removed after deleting entry `id`, or undefined when nothing
// should be unmarked (#498): undefined when the id isn't among the loaded entries, or when another
// loaded entry still falls on that day. A loaded day holds all its entries, so "no other loaded entry
// on that day" means the day is now empty.
export function dayToUnmarkAfterDelete(
  entries: ReadonlyArray<FlatEntry>,
  id: string
): string | undefined {
  const removed = entries.find((entry) => entry.id === id);
  if (removed === undefined) {
    return undefined;
  }
  const dayStillHasEntry = entries.some((entry) => entry.id !== id && entry.date === removed.date);
  return dayStillHasEntry ? undefined : removed.date;
}

function dayLabel(dayKey: string): string {
  return new Date(`${dayKey}T00:00:00Z`).toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    weekday: "long",
    year: "numeric"
  });
}

function monthLabel(monthKey: string): string {
  return new Date(`${monthKey}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    timeZone: "UTC",
    year: "numeric"
  });
}

function timeLabel(createdAt: string): string {
  return new Date(createdAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

type DiaryPageProps = Readonly<{ capture: CaptureVoiceDependencies }>;

export function DiaryPage({ capture }: DiaryPageProps): React.JSX.Element {
  const [load, setLoad] = useState<LoadState>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [entries, setEntries] = useState<ReadonlyArray<FlatEntry>>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [monthKey, setMonthKey] = useState(() => toMonthKey(toDayKey(new Date())));
  const [markedDays, setMarkedDays] = useState<ReadonlySet<string>>(new Set());
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);

  // Mirrors of the paging state, read inside async callbacks (the IntersectionObserver tick, a date jump)
  // so they act on the latest committed values rather than a stale closure.
  const entriesRef = useRef(entries);
  const cursorRef = useRef(cursor);
  const hasMoreRef = useRef(hasMore);
  const busyRef = useRef(false);
  const dayRefs = useRef(new Map<string, HTMLElement>());
  // The id of a just-saved entry to scroll into view once it mounts (see the entry `ref` below).
  const pendingEntryScrollRef = useRef<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);
  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);
  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  const grouped = useMemo(() => groupByDayDesc(entries), [entries]);

  // Load the first (newest) page on mount and on retry. The async work awaits before any setState so the
  // effect never updates state synchronously in its body.
  useEffect(() => {
    fetchTimeline(undefined, PAGE_SIZE).then(
      ({ days }) => {
        setEntries(flatten(days));
        setCursor(days.at(-1)?.date);
        setHasMore(days.length === PAGE_SIZE);
        setLoad("ready");
      },
      () => setLoad("error")
    );
  }, [reloadKey]);

  // The date-jump calendar's marks for the visible month. Non-critical: a failure simply shows no marks.
  useEffect(() => {
    const { from, to } = monthBounds(monthKey);
    fetchDiaryCalendar(from, to).then(
      (dto) => setMarkedDays(new Set(dto.dates)),
      () => setMarkedDays(new Set())
    );
  }, [monthKey]);

  // After a jump has loaded (and rendered) the target day, scroll its header into view, then clear.
  useEffect(() => {
    if (pendingScroll === null) {
      return;
    }
    const element = dayRefs.current.get(pendingScroll);
    if (element !== undefined) {
      element.scrollIntoView();
      setPendingScroll(null);
    }
  }, [grouped, pendingScroll]);

  function fail(message: string): void {
    setNotice(message);
  }

  // Mark the day of a just-saved entry immediately, so the date-jump calendar reflects it without waiting
  // for a month change/reload to re-fetch marks (#471). The month effect still refreshes marks whenever the
  // visible month changes, so this only needs to add the new day to the current set.
  function markEntryDay(entryDate: string): void {
    setMarkedDays((previous) => {
      if (previous.has(entryDate)) {
        return previous;
      }
      const next = new Set(previous);
      next.add(entryDate);
      return next;
    });
  }

  // Remove a day's calendar mark when its last entry is deleted (#498). The timeline loads all of a
  // day's entries together, so a loaded day's entry set is complete — the caller unmarks only after
  // confirming no other loaded entry remains on that day.
  function unmarkEntryDay(entryDate: string): void {
    setMarkedDays((previous) => {
      if (!previous.has(entryDate)) {
        return previous;
      }
      const next = new Set(previous);
      next.delete(entryDate);
      return next;
    });
  }

  async function loadMore(): Promise<void> {
    if (busyRef.current || !hasMoreRef.current) {
      return;
    }
    busyRef.current = true;
    setLoadingMore(true);
    try {
      const { days } = await fetchTimeline(cursorRef.current, PAGE_SIZE);
      setEntries((previous) => [...previous, ...flatten(days)]);
      setCursor((previous) => days.at(-1)?.date ?? previous);
      setHasMore(days.length === PAGE_SIZE);
    } catch {
      setHasMore(false);
      fail("Couldn't load older entries.");
    } finally {
      busyRef.current = false;
      setLoadingMore(false);
    }
  }

  // Lazy-load older days as the sentinel below the timeline scrolls into view. Re-subscribes when the
  // sentinel mounts/unmounts (load + hasMore changes) so it only observes while there is more to fetch.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (sentinel === null) {
      return;
    }
    const observer = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) {
        void loadMore();
      }
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, hasMore]);

  function handleCaptured(entry: DiaryEntryDto): void {
    setNotice(null);
    setEntries((previous) => [...previous, toFlat(entry)]);
    markEntryDay(entry.entryDate);
    pendingEntryScrollRef.current = entry.id;
  }

  async function saveEdit(id: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    setNotice(null);
    try {
      const updated = await updateDiaryEntry(id, trimmed);
      setEntries((previous) =>
        previous.map((entry) => (entry.id === id ? { ...entry, text: updated.text } : entry))
      );
      setEditingId(null);
    } catch {
      fail("Couldn't save your edit.");
    }
  }

  async function removeEntry(id: string): Promise<void> {
    setNotice(null);
    try {
      await deleteDiaryEntry(id);
      const dayToUnmark = dayToUnmarkAfterDelete(entriesRef.current, id);
      setEntries((previous) => previous.filter((entry) => entry.id !== id));
      // Drop the calendar mark when the deleted entry was the last one on its day (#498).
      if (dayToUnmark !== undefined) {
        unmarkEntryDay(dayToUnmark);
      }
    } catch {
      fail("Couldn't delete that entry.");
    }
  }

  async function jumpToDay(day: string): Promise<void> {
    setNotice(null);
    let loaded = entriesRef.current;
    let before = cursorRef.current;
    let more = hasMoreRef.current;
    try {
      while (more && !loaded.some((entry) => entry.date === day)) {
        const { days } = await fetchTimeline(before, PAGE_SIZE);
        loaded = [...loaded, ...flatten(days)];
        before = days.at(-1)?.date ?? before;
        more = days.length === PAGE_SIZE;
      }
      setEntries(loaded);
      setCursor(before);
      setHasMore(more);
      setPendingScroll(day);
    } catch {
      fail("Couldn't jump to that day.");
    }
  }

  if (load === "loading") {
    return <LoadingIndicator label="Opening your diary…" />;
  }

  if (load === "error") {
    return (
      <Shell>
        <div role="alert">
          <p className="text-danger">We couldn&apos;t open your diary.</p>
          <Button
            className="mt-3"
            onClick={() => {
              setLoad("loading");
              setReloadKey((previous) => previous + 1);
            }}
          >
            Try again
          </Button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex flex-col gap-6">
        <CaptureCard capture={capture} onCaptured={handleCaptured} />

        {notice !== null ? (
          <p
            className="rounded border border-border bg-surface px-3 py-2 text-sm text-danger"
            role="alert"
          >
            {notice}
          </p>
        ) : null}

        <DiaryCalendar
          markedDays={markedDays}
          monthKey={monthKey}
          onJump={(day) => void jumpToDay(day)}
          onShiftMonth={(delta) => setMonthKey((previous) => shiftMonth(previous, delta))}
        />

        {grouped.length === 0 ? (
          <p className="text-text-muted">
            No entries yet — tap to talk and your first diary moment lands here.
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {grouped.map((group) => (
              <section
                aria-label={dayLabel(group.date)}
                className="flex flex-col gap-2"
                key={group.date}
              >
                <h2
                  className="sticky top-0 bg-bg py-1 text-sm font-semibold text-text-muted"
                  ref={(element) => {
                    if (element !== null) {
                      dayRefs.current.set(group.date, element);
                    }
                  }}
                >
                  {dayLabel(group.date)}
                </h2>
                <ul className="flex flex-col gap-2">
                  {group.entries.map((entry) => (
                    <li
                      className="rounded border border-border bg-surface p-3"
                      key={entry.id}
                      ref={(element) => {
                        // Scroll a freshly saved entry into view when it mounts. On mobile the compose
                        // form and date-jump calendar sit above the timeline, so a new entry lands under
                        // the fold with its Edit/Delete actions clipped behind the bottom navigation
                        // (#506); `block: "nearest"` lifts the whole entry the minimal amount above the nav.
                        if (element !== null && pendingEntryScrollRef.current === entry.id) {
                          element.scrollIntoView({ block: "nearest" });
                          pendingEntryScrollRef.current = null;
                        }
                      }}
                    >
                      {editingId === entry.id ? (
                        <EditForm
                          initial={entry.text}
                          onCancel={() => setEditingId(null)}
                          onSave={(text) => void saveEdit(entry.id, text)}
                        />
                      ) : (
                        <div className="flex flex-col gap-2">
                          <p className="whitespace-pre-wrap text-text">{entry.text}</p>
                          <div className="flex items-center gap-3">
                            <span className="text-xs text-text-muted">
                              {timeLabel(entry.createdAt)}
                            </span>
                            <Button
                              onClick={() => setEditingId(entry.id)}
                              size="sm"
                              variant="ghost"
                            >
                              Edit
                            </Button>
                            <Button
                              onClick={() => void removeEntry(entry.id)}
                              size="sm"
                              variant="ghost"
                            >
                              Delete
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        {hasMore ? (
          <div ref={sentinelRef}>
            {loadingMore ? <LoadingIndicator label="Loading older entries…" /> : null}
          </div>
        ) : null}
      </div>
    </Shell>
  );
}

function Shell({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <section aria-labelledby="diary-heading" className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold text-text" id="diary-heading">
        Diary
      </h1>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function EditForm({
  initial,
  onCancel,
  onSave
}: Readonly<{
  initial: string;
  onCancel: () => void;
  onSave: (text: string) => void;
}>): React.JSX.Element {
  const [draft, setDraft] = useState(initial);

  return (
    <div className="flex flex-col gap-2">
      <textarea
        aria-label="Edit entry"
        className="min-h-16 rounded border border-border bg-surface p-2 text-text"
        onChange={(event) => setDraft(event.currentTarget.value)}
        value={draft}
      />
      <div className="flex gap-2">
        <Button onClick={() => onSave(draft)} size="sm">
          Save
        </Button>
        <Button onClick={onCancel} size="sm" variant="secondary">
          Cancel
        </Button>
      </div>
    </div>
  );
}

function DiaryCalendar({
  markedDays,
  monthKey,
  onJump,
  onShiftMonth
}: Readonly<{
  markedDays: ReadonlySet<string>;
  monthKey: string;
  onJump: (day: string) => void;
  onShiftMonth: (delta: number) => void;
}>): React.JSX.Element {
  return (
    <section aria-label="Jump to a day" className="rounded border border-border bg-surface p-3">
      <div className="flex items-center justify-between">
        <Button
          aria-label="Previous month"
          className="min-w-11"
          onClick={() => onShiftMonth(-1)}
          size="sm"
          variant="ghost"
        >
          ‹
        </Button>
        <span className="text-sm font-medium text-text">{monthLabel(monthKey)}</span>
        <Button
          aria-label="Next month"
          className="min-w-11"
          onClick={() => onShiftMonth(1)}
          size="sm"
          variant="ghost"
        >
          ›
        </Button>
      </div>
      <table className="mt-2 w-full table-fixed text-center text-sm">
        <thead>
          <tr className="text-text-muted">
            {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((weekday, index) => (
              <th className="py-1 font-normal" key={index} scope="col">
                {weekday}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthGrid(monthKey).map((week, weekIndex) => (
            <tr key={weekIndex}>
              {week.map((cell, dayIndex) =>
                cell === null ? (
                  <td className="py-1" key={dayIndex} />
                ) : (
                  <td className="py-1" key={dayIndex}>
                    {markedDays.has(cell) ? (
                      <button
                        aria-label={`Go to ${cell}`}
                        className="mx-auto flex size-11 items-center justify-center rounded-full bg-accent text-accent-fg"
                        onClick={() => onJump(cell)}
                        type="button"
                      >
                        {Number(cell.slice(8))}
                      </button>
                    ) : (
                      <span className="text-text-muted">{Number(cell.slice(8))}</span>
                    )}
                  </td>
                )
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
