import { WorkContentPanel } from "./features/content/WorkContentPanel";
import { AdminLibraryPage } from "./features/library/AdminLibraryPage";
import { ReaderPage } from "./features/reader/ReaderPage";

export function App(): React.JSX.Element {
  return (
    <>
      <AdminLibraryPage />
      <WorkContentPanel />
      <ReaderPage />
    </>
  );
}
