import { useEffect, useMemo, useRef, useState } from "react";

import type { DiaryEntryDto, TimelineDayDto } from "@whetstone/contracts";
import { documentText, type DocumentNodeJSON } from "@whetstone/document";
import { groupTimelineEntriesByDay, localDayKey } from "@whetstone/domain";

import { Button } from "../../shared/ui/Button.js";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator.js";
import { PageFrame } from "../../shared/ui/PageFrame.js";
import { RichContentEditor } from "../../shared/editor/index.js";
import {
  loadPersistedTimeZone,
  resolveBrowserTimeZone
} from "../../shared/preferences/preferencesApi.js";
import { CaptureCard, type CaptureVoiceDependencies } from "../capture/CaptureCard.js";
import { PmDocument } from "../reader/PmDocument.js";
import { deleteDiaryEntry, fetchTimeline, updateDiaryEntry } from "./diaryApi.js";
import { VoiceSourceRow } from "./VoiceSourceRow.js";
import {
  diaryScrollTop,
  diaryTimelineSnapshot,
  rememberDiaryScrollTop,
  rememberDiaryTimeline
} from "./diarySessionStore.js";

// How many days the Timeline loads per page (matches the server's default page size).
const PAGE_SIZE = 7;

// A diary timeline entry flattened with the day it falls under, so `groupTimelineEntriesByDay` can
// regroup the loaded entries (capture prepends, lazy-load appends older) into day sections without
// another fetch, preserving the server Timeline order (newest-first by `occurredAt`, `entryId` ascending
// as a stable tie-break) within each day. The durable body is the rich ProseMirror/Tiptap document;
// `bodyText` is its readable projection used for the read view and the collapsed timeline preview.
export type FlatEntry = Readonly<{
  bodyDoc: DocumentNodeJSON;
  bodyText: string;
  date: string;
  entryId: string;
  inputMode: DiaryEntryDto["inputMode"];
  kind: "diary";
  language: string | null;
  occurredAt: string;
}>;

type LoadState = "loading" | "ready" | "error";

// The Timeline is a mixed logical view over the current user's personal Entries (#571); the Diary is the
// `kind === "diary"` filter over it, so note rows are dropped here.
function flatten(days: ReadonlyArray<TimelineDayDto>): ReadonlyArray<FlatEntry> {
  return days.flatMap((day) =>
    day.entries.flatMap((entry) =>
      entry.kind === "diary"
        ? [
            {
              bodyDoc: entry.bodyDoc,
              bodyText: entry.bodyText,
              date: day.date,
              entryId: entry.entryId,
              inputMode: entry.inputMode,
              kind: "diary" as const,
              language: entry.language,
              occurredAt: entry.occurredAt
            }
          ]
        : []
    )
  );
}

function toFlat(entry: DiaryEntryDto, timeZone: string): FlatEntry {
  return {
    bodyDoc: entry.bodyDoc,
    bodyText: entry.bodyText,
    date: localDayKey(new Date(entry.occurredAt), timeZone),
    entryId: entry.id,
    inputMode: entry.inputMode,
    kind: "diary",
    language: entry.language,
    occurredAt: entry.occurredAt
  };
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

function timeLabel(createdAt: string): string {
  return new Date(createdAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

type DiaryPageProps = Readonly<{ capture: CaptureVoiceDependencies }>;

export function DiaryPage({ capture }: DiaryPageProps): React.JSX.Element {
  // The snapshot remembered for this app session, captured once at mount so the first render restores it
  // (#648) and a later write (from a page load) cannot change which branch this mount took.
  const [restoredSnapshot] = useState(diaryTimelineSnapshot);
  const [load, setLoad] = useState<LoadState>(() =>
    restoredSnapshot === null ? "loading" : "ready"
  );
  const [reloadKey, setReloadKey] = useState(0);
  const [entries, setEntries] = useState<ReadonlyArray<FlatEntry>>(
    () => restoredSnapshot?.entries ?? []
  );
  const [cursor, setCursor] = useState<string | undefined>(() => restoredSnapshot?.cursor);
  const [hasMore, setHasMore] = useState(() => restoredSnapshot?.hasMore ?? false);
  const [loadingMore, setLoadingMore] = useState(false);
  // An older-page (lazy-load) request failed. Distinct from the real terminal page: `hasMore` and the
  // cursor stay intact so the request is retryable, and the sentinel region shows an explicit retry
  // affordance (#648). Auto lazy-load is paused while this is set so a visible sentinel does not spam the
  // failing request; an explicit retry clears it and tries again.
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The learner's calendar-day zone (#606): starts from the browser so the first render groups sensibly,
  // then adopts the server-owned preference once loaded. Day sections and the new-entry day derive from
  // it, so the client and server agree on which local day each entry falls under.
  const [timeZone, setTimeZone] = useState(() => resolveBrowserTimeZone());
  // Gate the first timeline load until the learner's zone is resolved *and persisted* (#606). On first
  // use, `loadPersistedTimeZone` writes the browser zone before resolving, so once this flips true the
  // server's timeline queries group by the same zone the client pages with — the day-key cursor stays
  // coherent across pages instead of mixing a UTC-fallback first page with browser-zone older pages.
  const [zoneReady, setZoneReady] = useState(false);

  // Mirrors of the paging state, read inside async callbacks (the IntersectionObserver tick) so they act
  // on the latest committed values rather than a stale closure.
  const cursorRef = useRef(cursor);
  const hasMoreRef = useRef(hasMore);
  const busyRef = useRef(false);
  // Mirrors `loadMoreFailed` so the IntersectionObserver tick pauses auto lazy-loading after a failure
  // without waiting for a re-render (#648).
  const loadMoreFailedRef = useRef(loadMoreFailed);
  // The id of a just-saved entry to scroll into view once it mounts (see the entry `ref` below).
  const pendingEntryScrollRef = useRef<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // The Diary content root; the scroll container is its nearest ancestor `<main>` (the AppShell scroller).
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Whether this mount restored a snapshot on its first render, so the first-page fetch is skipped (#648).
  const restoredRef = useRef(restoredSnapshot !== null);

  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);
  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  const grouped = useMemo(() => groupTimelineEntriesByDay(entries, timeZone), [entries, timeZone]);

  // Adopt the learner's server-owned timezone once, waiting for the first-use default to persist before
  // marking the zone ready (#606), so day grouping and the timeline cursor match the server's projection.
  // A failed resolve still flips ready so the timeline can load (and surface its own error) under the
  // browser-zone fallback rather than hanging on the loading state.
  useEffect(() => {
    let active = true;
    loadPersistedTimeZone().then(
      (zone) => {
        if (active) {
          setTimeZone(zone);
          setZoneReady(true);
        }
      },
      () => {
        if (active) {
          setZoneReady(true);
        }
      }
    );
    return () => {
      active = false;
    };
  }, []);

  // Load the first (newest) page on mount and on retry, but only once the learner's zone is persisted so
  // the server groups this page — and every older page's cursor — by that one zone (#606). Skipped when
  // this mount restored a session snapshot (#648): the remembered timeline is already shown. The async
  // work awaits before any setState so the effect never updates state synchronously in its body.
  useEffect(() => {
    if (!zoneReady || restoredRef.current) {
      return;
    }
    fetchTimeline(undefined, PAGE_SIZE).then(
      ({ days }) => {
        setEntries(flatten(days));
        setCursor(days.at(-1)?.date);
        setHasMore(days.length === PAGE_SIZE);
        setLoad("ready");
      },
      () => setLoad("error")
    );
  }, [reloadKey, zoneReady]);

  // Remember the loaded timeline for the app session so returning to Diary restores it (#648). Kept in
  // sync on every paging change while ready; a full reload clears it (a new session).
  useEffect(() => {
    if (load === "ready") {
      rememberDiaryTimeline({ cursor, entries, hasMore });
    }
  }, [cursor, entries, hasMore, load]);

  // Preserve the learner's scroll position across leaving and returning to Diary in the same app session
  // (#648). The scroll container is the AppShell `<main>` (Diary itself does not scroll), so reapply the
  // remembered offset once the timeline is ready (and its restored content has rendered tall enough to
  // hold that position), then keep the offset current via a passive scroll listener. The effect re-runs
  // only when `load` reaches "ready", so the reapply happens once per mount.
  useEffect(() => {
    if (load !== "ready") {
      return;
    }
    const container = rootRef.current?.closest("main");
    if (container === null || container === undefined) {
      return;
    }
    // The capture editor mounts asynchronously (RichContentEditor uses `immediatelyRender: false`, #678),
    // so it grows from a short placeholder to its full height just above the restored scroll position.
    // The browser's scroll anchoring would convert that late growth-above into a scroll shift, landing the
    // learner on different entries than they left (the remembered offset would read too large). Opt this
    // container out of anchoring while Diary owns it so the remembered offset lands on the same entries;
    // the prior value is restored on unmount.
    const previousOverflowAnchor = container.style.overflowAnchor;
    container.style.overflowAnchor = "none";
    container.scrollTop = diaryScrollTop();
    const handleScroll = (): void => {
      rememberDiaryScrollTop(container.scrollTop);
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.style.overflowAnchor = previousOverflowAnchor;
      container.removeEventListener("scroll", handleScroll);
    };
  }, [load]);

  function fail(message: string): void {
    setNotice(message);
  }

  async function loadMore(): Promise<void> {
    if (busyRef.current || !hasMoreRef.current || loadMoreFailedRef.current) {
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
      // Keep `hasMore`/cursor intact so the older page is retryable, and pause auto lazy-load until the
      // learner retries — the sentinel region shows the explicit retry affordance (#648).
      loadMoreFailedRef.current = true;
      setLoadMoreFailed(true);
    } finally {
      busyRef.current = false;
      setLoadingMore(false);
    }
  }

  // Explicitly retry a failed older-page load: clear the failure gate and request the same page again.
  async function retryLoadMore(): Promise<void> {
    loadMoreFailedRef.current = false;
    setLoadMoreFailed(false);
    await loadMore();
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
  }, [load, hasMore]);

  function handleCaptured(entry: DiaryEntryDto): void {
    setNotice(null);
    const flat = toFlat(entry, timeZone);
    setEntries((previous) => [...previous, flat]);
    pendingEntryScrollRef.current = entry.id;
  }

  async function saveEdit(id: string, bodyDoc: DocumentNodeJSON): Promise<void> {
    // A blank body is not a diary edit — keep the entry as it was rather than emptying it.
    if (documentText(bodyDoc).trim().length === 0) {
      return;
    }
    setNotice(null);
    try {
      const updated = await updateDiaryEntry(id, bodyDoc);
      setEntries((previous) =>
        previous.map((entry) =>
          entry.entryId === id
            ? { ...entry, bodyDoc: updated.bodyDoc, bodyText: updated.bodyText }
            : entry
        )
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
      setEntries((previous) => previous.filter((entry) => entry.entryId !== id));
    } catch {
      fail("Couldn't delete that entry.");
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
      <div className="flex flex-col gap-6" ref={rootRef}>
        <CaptureCard capture={capture} onCaptured={handleCaptured} presentation="workspace" />

        {notice !== null ? (
          <p
            className="rounded border border-border bg-surface px-3 py-2 text-sm text-danger"
            role="alert"
          >
            {notice}
          </p>
        ) : null}

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
                <h2 className="sticky top-0 bg-bg py-1 text-sm font-semibold text-text-muted">
                  {dayLabel(group.date)}
                </h2>
                <ul className="flex flex-col gap-2">
                  {group.entries.map((entry) => (
                    <li
                      className="rounded border border-border bg-surface p-3"
                      key={entry.entryId}
                      ref={(element) => {
                        // Scroll a freshly saved entry into view when it mounts. On mobile the compose
                        // form sits above the timeline, so a new entry lands under the fold with its
                        // Edit/Delete actions clipped behind the bottom navigation (#506); `block:
                        // "nearest"` lifts the whole entry the minimal amount above the nav.
                        if (element !== null && pendingEntryScrollRef.current === entry.entryId) {
                          element.scrollIntoView({ block: "nearest" });
                          pendingEntryScrollRef.current = null;
                        }
                      }}
                    >
                      {editingId === entry.entryId ? (
                        <EditForm
                          entryId={entry.entryId}
                          initial={entry.bodyDoc}
                          inputMode={entry.inputMode}
                          onCancel={() => setEditingId(null)}
                          onSave={(bodyDoc) => void saveEdit(entry.entryId, bodyDoc)}
                        />
                      ) : (
                        <div className="flex flex-col gap-2">
                          <PmDocument document={entry.bodyDoc} />
                          <div className="flex items-center gap-3">
                            <span className="text-xs text-text-muted">
                              {timeLabel(entry.occurredAt)}
                            </span>
                            <Button
                              onClick={() => setEditingId(entry.entryId)}
                              size="sm"
                              variant="ghost"
                            >
                              Edit
                            </Button>
                            <Button
                              onClick={() => void removeEntry(entry.entryId)}
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
            {loadMoreFailed ? (
              <div className="flex flex-col items-start gap-2" role="alert">
                <p className="text-sm text-danger">Couldn&apos;t load older entries.</p>
                <Button onClick={() => void retryLoadMore()} size="sm" variant="secondary">
                  Try again
                </Button>
              </div>
            ) : loadingMore ? (
              <LoadingIndicator label="Loading older entries…" />
            ) : null}
          </div>
        ) : null}
      </div>
    </Shell>
  );
}

function Shell({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <PageFrame title="Diary">{children}</PageFrame>;
}

// Editing a diary body uses the shared rich editor (#571): the durable ProseMirror/Tiptap document is
// edited in place, and Save persists the new document. `draft` mirrors the editor's live document so the
// explicit Save button (and the editor's own Save affordance) persist the latest content. A voice entry
// (#801) also mounts a read-only `VoiceSourceRow` above the editor so the learner can audit the body
// against the retained recording and transcript; typed entries have no source to audit and show none.
function EditForm({
  entryId,
  initial,
  inputMode,
  onCancel,
  onSave
}: Readonly<{
  entryId: string;
  initial: DocumentNodeJSON;
  inputMode: DiaryEntryDto["inputMode"];
  onCancel: () => void;
  onSave: (bodyDoc: DocumentNodeJSON) => void;
}>): React.JSX.Element {
  const [draft, setDraft] = useState<DocumentNodeJSON>(initial);

  return (
    <div className="flex flex-col gap-2">
      {inputMode === "voice" ? <VoiceSourceRow entryId={entryId} key={entryId} /> : null}
      <RichContentEditor
        ariaLabel="Edit entry"
        document={initial}
        onChange={setDraft}
        onSave={onSave}
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
