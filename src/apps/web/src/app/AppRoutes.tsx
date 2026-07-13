import { Route, Routes, useSearchParams } from "react-router-dom";

import { createCaptureVoice } from "../features/capture/captureVoice.js";
import { AuthoredWorkPage } from "../features/authoredWorks/AuthoredWorkPage.js";
import { DiaryPage } from "../features/diary/DiaryPage.js";
import { MemoryPage } from "../features/memory/MemoryPage.js";
import { NotesPage } from "../features/notes/NotesPage.js";
import { ReaderPage } from "../features/reader/ReaderPage.js";
import { RecallPage } from "../features/recall/RecallPage.js";
import { RecitePage } from "../features/recitation/RecitePage.js";
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

// The Library's "Divide into passages" action on a recitation plan routes to `#/recite?plan=<entryId>`;
// the route reads that param so the segmentation page can load one plan's passages. Without it, the page
// prompts the learner to open a routine from the Library.
function ReciteRoute(): React.JSX.Element {
  const [searchParams] = useSearchParams();

  return <RecitePage planEntryId={searchParams.get("plan") ?? undefined} />;
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
        <Route element={<MemoryPage />} path="memory" />
        <Route element={<RecallPage />} path="recall" />
        <Route element={<ReciteRoute />} path="recite" />
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
