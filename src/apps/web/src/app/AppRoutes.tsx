import { Navigate, Route, Routes, useSearchParams } from "react-router-dom";

import { createCaptureVoice } from "../features/capture/captureVoice.js";
import { AuthoredWorkPage } from "../features/authoredWorks/AuthoredWorkPage.js";
import { DiaryPage } from "../features/diary/DiaryPage.js";
import { NotesPage } from "../features/notes/NotesPage.js";
import { ReaderPage } from "../features/reader/ReaderPage.js";
import { NotesReviewPage } from "../features/notesReview/NotesReviewPage.js";
import { RecitationReviewPage } from "../features/recitation/RecitationReviewPage.js";
import { SearchPage } from "../features/search/SearchPage.js";
import { TodayPage } from "../features/today/TodayPage.js";
import { AppShell } from "./AppShell.js";
import { LibraryMode } from "./LibraryMode.js";
import { NotFoundPage } from "./NotFoundPage.js";

// The reader route opens straight into a work when the library passes `?work=<entryId>`;
// an optional `?block=<entryId>` deep-links to a specific block. Without a work param the
// reader shows its empty state prompting the reader to open a work from the Library.
function ReaderRoute(): React.JSX.Element {
  const [searchParams] = useSearchParams();

  return (
    <ReaderPage
      initialBlockEntryId={searchParams.get("block") ?? undefined}
      initialWorkEntryId={searchParams.get("work") ?? undefined}
    />
  );
}

// The authoring route opens the immersive rich editor for an owned Work passed as `?work=<entryId>`.
// Without a work param the page shows a calm prompt to open a document from the Library.
function WriteRoute(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const workEntryId = searchParams.get("work") ?? undefined;

  // Key by the work so switching documents remounts the editor to its initial loading state, letting the
  // load effect set state only from its async callbacks (no synchronous setState in an effect).
  return <AuthoredWorkPage key={workEntryId ?? "none"} workEntryId={workEntryId} />;
}

// The Library's contextual "Notes" action routes to `#/notes?work=<entryId>`; the route reads that
// param so the Notes list can narrow to a single work. Without it, Notes shows every saved note.
function NotesRoute(): React.JSX.Element {
  const [searchParams] = useSearchParams();

  return <NotesPage focusWorkEntryId={searchParams.get("work") ?? undefined} />;
}

// A contextual Recitation entry (Reader header, Library card, Today) routes to
// `#/recitation?work=<entryId>`; the route reads that param so the page opens THAT exact Work's direct
// maintenance review — or a calm Library recovery when it is not due (#643). Without it, the earliest-due
// Work's review opens.
function RecitationRoute(): React.JSX.Element {
  const [searchParams] = useSearchParams();

  return <RecitationReviewPage workEntryId={searchParams.get("work") ?? undefined} />;
}

// Routes for the four navigation modes, all nested under the shell layout. Hash/memory
// routing is provided by the composition root so this works under file/Capacitor/Tauri.
export function AppRoutes(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />} path="/">
        <Route element={<TodayPage />} index />
        <Route element={<LibraryMode />} path="library" />
        <Route element={<ReaderRoute />} path="reader" />
        <Route element={<WriteRoute />} path="write" />
        {/* The standalone Memory/Recall experience is retired (#662): `/memory` and `/recall` are
            compatibility redirects (history-replaced so back/forward never loops through them) into the
            Notes home and the Notes-owned Review session, which read due/card state from the database. */}
        <Route element={<Navigate replace to="/notes" />} path="memory" />
        <Route element={<NotesReviewPage />} path="notes/review" />
        <Route element={<Navigate replace to="/notes/review" />} path="recall" />
        {/* The retired passage-segmentation route (`/recite?plan=`) has no direct-maintenance equivalent —
            its plan-scoped setup is gone (#643) — so it redirects to the Library recovery path rather than
            opening a dead or misleading screen. */}
        <Route element={<Navigate replace to="/library" />} path="recite" />
        <Route element={<RecitationRoute />} path="recitation" />
        <Route element={<NotesRoute />} path="notes" />
        <Route element={<DiaryPage capture={createCaptureVoice()} />} path="diary" />
        <Route element={<SearchPage />} path="search" />
        {/* Any unrecognized path — including retired routes like /practice and /progress — resolves to
            the calm not-found page inside the shell, never a blank screen. */}
        <Route element={<NotFoundPage />} path="*" />
      </Route>
    </Routes>
  );
}
