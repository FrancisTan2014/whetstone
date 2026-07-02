import { useState } from "react";

import { WorkContentPanel } from "../features/content/WorkContentPanel.js";
import { AdminLibraryPage } from "../features/library/AdminLibraryPage.js";
import { Sheet } from "../shared/ui/Sheet.js";

// The Library mode is now shelf-first (#392): the calm grouped shelf is the whole page, and raw
// content management (manual Markdown input, `.md` upload, and the units/blocks inspection) lives in
// a focused, on-demand "Manage content" sheet instead of an always-visible panel below the shelf.
// This app-level composition owns the cross-feature wiring: the shelf emits which work to manage and
// this opens the content feature's panel over it.
export function LibraryMode(): React.JSX.Element {
  const [manageWorkEntryId, setManageWorkEntryId] = useState<string | undefined>(undefined);

  return (
    <>
      <AdminLibraryPage onManageContent={setManageWorkEntryId} />
      {manageWorkEntryId !== undefined ? (
        <Sheet
          onOpenChange={() => {
            // The sheet is only rendered while open, and Radix only calls this to request
            // dismissal (Esc / overlay / close button), so any change clears the managed work.
            setManageWorkEntryId(undefined);
          }}
          open
          title="Manage content"
        >
          <WorkContentPanel focusWorkEntryId={manageWorkEntryId} />
        </Sheet>
      ) : null}
    </>
  );
}
