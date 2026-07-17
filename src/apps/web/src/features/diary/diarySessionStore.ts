import type { FlatEntry } from "./DiaryPage.js";

// The Diary's remembered place for the current app session (#648). When the learner leaves Diary and
// returns, the page restores the exact Timeline they were reading — including older pages they had
// lazy-loaded — and their scroll offset, rather than snapping back to the newest page at the top. The
// state is in-memory (module scope), so it survives Diary unmounting on navigation but resets on a full
// page reload: a new app session opens Diary fresh at the top. Kept in its own module so the page stays a
// thin consumer and the remembered place can be cleared (e.g. on a future user switch) in one place.

// The loaded Timeline the learner last saw: the flattened diary entries plus the paging cursor and
// whether older pages remain. Restoring this avoids a refetch and preserves lazily loaded older days.
export type DiaryTimelineSnapshot = Readonly<{
  entries: ReadonlyArray<FlatEntry>;
  cursor: string | undefined;
  hasMore: boolean;
}>;

type DiarySession = {
  snapshot: DiaryTimelineSnapshot | null;
  scrollTop: number;
};

const session: DiarySession = { scrollTop: 0, snapshot: null };

// The remembered Timeline, or null when Diary has not been loaded this session (open fresh, then fetch).
export function diaryTimelineSnapshot(): DiaryTimelineSnapshot | null {
  return session.snapshot;
}

// The remembered scroll offset of the Diary scroll container.
export function diaryScrollTop(): number {
  return session.scrollTop;
}

// Remember the currently loaded Timeline so a later return restores it.
export function rememberDiaryTimeline(snapshot: DiaryTimelineSnapshot): void {
  session.snapshot = snapshot;
}

// Remember the current scroll offset so a later return restores the reading position.
export function rememberDiaryScrollTop(scrollTop: number): void {
  session.scrollTop = scrollTop;
}

// Forget the remembered place: the next open loads Diary fresh at the top.
export function clearDiarySession(): void {
  session.snapshot = null;
  session.scrollTop = 0;
}
