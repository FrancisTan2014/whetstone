import { Route, Routes, useSearchParams } from "react-router-dom";

import { createCaptureVoice } from "../features/capture/captureVoice.js";
import { DiaryPage } from "../features/diary/DiaryPage.js";
import { NotesPage } from "../features/notes/NotesPage.js";
import { ProgressMapPage } from "../features/progress/ProgressMapPage.js";
import { ReaderPage } from "../features/reader/ReaderPage.js";
import { RecallPage } from "../features/recall/RecallPage.js";
import { SearchPage } from "../features/search/SearchPage.js";
import { SessionPage } from "../features/session/SessionPage.js";
import { TodayPage } from "../features/today/TodayPage.js";
import { createLiveCapture, isVoiceCaptureSupported } from "../features/session/liveCapture.js";
import { createBrowserVoiceOut } from "../features/session/browserVoiceOut.js";
import { AppShell } from "./AppShell.js";
import { LibraryMode } from "./LibraryMode.js";

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

// The Library's contextual "Notes" action routes to `#/notes?work=<entryId>`; the route reads that
// param so the Notes list can narrow to a single work. Without it, Notes shows every saved note.
function NotesRoute(): React.JSX.Element {
  const [searchParams] = useSearchParams();

  return <NotesPage focusWorkEntryId={searchParams.get("work") ?? undefined} />;
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
        <Route
          element={
            <SessionPage
              live={{
                createCapture: createLiveCapture,
                createVoiceOut: createBrowserVoiceOut,
                supported: isVoiceCaptureSupported()
              }}
            />
          }
          path="practice"
        />
        <Route element={<ProgressMapPage />} path="progress" />
        <Route element={<RecallPage />} path="recall" />
        <Route element={<NotesRoute />} path="notes" />
        <Route element={<DiaryPage capture={createCaptureVoice()} />} path="diary" />
        <Route element={<SearchPage />} path="search" />
      </Route>
    </Routes>
  );
}
