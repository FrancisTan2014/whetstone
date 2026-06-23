import { WorkContentPanel } from "./features/content/WorkContentPanel";
import { AdminLibraryPage } from "./features/library/AdminLibraryPage";

export function App(): React.JSX.Element {
  return (
    <>
      <AdminLibraryPage />
      <WorkContentPanel />
    </>
  );
}
