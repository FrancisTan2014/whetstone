import { Route, Routes, useSearchParams } from "react-router-dom";

import { WorkContentPanel } from "../features/content/WorkContentPanel.js";
import { AdminLibraryPage } from "../features/library/AdminLibraryPage.js";
import { ReaderPage } from "../features/reader/ReaderPage.js";
import { AppShell } from "./AppShell.js";
import { ModePlaceholder } from "./ModePlaceholder.js";

// The Library mode keeps the existing admin + content screens mounted together; screen
// redesign happens in later slices.
function LibraryMode(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-5xl p-4">
      <AdminLibraryPage />
      <WorkContentPanel />
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
        <Route
          element={
            <ModePlaceholder
              description="Your notes across works arrive in a later slice."
              mode="Notes"
            />
          }
          path="notes"
        />
        <Route
          element={
            <ModePlaceholder
              description="Block-level search arrives in a later slice."
              mode="Search"
            />
          }
          path="search"
        />
      </Route>
    </Routes>
  );
}
