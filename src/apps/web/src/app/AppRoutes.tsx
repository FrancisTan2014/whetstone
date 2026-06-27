import { useState } from "react";
import { Route, Routes, useSearchParams } from "react-router-dom";

import { WorkContentPanel } from "../features/content/WorkContentPanel.js";
import { AdminLibraryPage } from "../features/library/AdminLibraryPage.js";
import { NotesPage } from "../features/notes/NotesPage.js";
import { ProgressMapPage } from "../features/progress/ProgressMapPage.js";
import { ReaderPage } from "../features/reader/ReaderPage.js";
import { SearchPage } from "../features/search/SearchPage.js";
import { AppShell } from "./AppShell.js";

// The Library mode keeps the existing admin + content screens mounted together; screen
// redesign happens in later slices. It lifts the just-created work's entry id so the content
// panel refreshes and selects a newly added/imported work without a page reload.
function LibraryMode(): React.JSX.Element {
  const [focusWorkEntryId, setFocusWorkEntryId] = useState<string | undefined>(undefined);

  return (
    <div className="mx-auto max-w-5xl p-4">
      <AdminLibraryPage onWorkCreated={setFocusWorkEntryId} />
      <WorkContentPanel focusWorkEntryId={focusWorkEntryId} />
    </div>
  );
}

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

// Routes for the four navigation modes, all nested under the shell layout. Hash/memory
// routing is provided by the composition root so this works under file/Capacitor/Tauri.
export function AppRoutes(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />} path="/">
        <Route element={<LibraryMode />} index />
        <Route element={<ReaderRoute />} path="reader" />
        <Route element={<ProgressMapPage />} path="progress" />
        <Route element={<NotesPage />} path="notes" />
        <Route element={<SearchPage />} path="search" />
      </Route>
    </Routes>
  );
}
