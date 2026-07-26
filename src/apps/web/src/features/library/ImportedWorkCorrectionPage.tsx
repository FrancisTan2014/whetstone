import { useEffect, useState } from "react";

import type { ImportedWorkDto } from "@whetstone/contracts";

import { LoadingIndicator } from "../../shared/ui/LoadingIndicator.js";
import {
  addImportedWorkSection,
  fetchImportedWork,
  fetchImportedWorkUnit,
  saveImportedWorkContent
} from "./importedWorkApi.js";
import type { WorkEditorApi } from "./workContentEditor.js";
import { EditorFrame, WorkContentEditor } from "./workContentEditor.js";

// The Library imported-Work correction page (#762): the administrative counterpart to the manual editor
// page. An administrator reaches it from an eligible imported Work's "Correct content" action to fix its
// canonical blocks (ordering, block types, text) in the SAME shared editor the manual page uses. It fetches
// the Work through the imported-correction endpoints, then hands it to the shared `WorkContentEditor` with
// the imported API adapter and one extra affordance the manual editor lacks — "Open in Reader" — so the
// administrator can jump straight to how a corrected Work now reads. The editing surface, Outline, revision
// fence (#703), and conflict/draft behavior are reused verbatim; correcting imported content never creates
// a personal Entry and never alters the immutable ingested source — it edits the shared canonical blocks in
// place, and the server stamps durable correction markers.

// Bind the shared editor to the imported-correction endpoints. The imported DTO is a structural superset of
// the shared editor's `WorkEditorWork`, so it satisfies the API contract without the editor knowing the
// origin; only the authority (administrative) and the absence of owner chronology differ.
const importedWorkEditorApi: WorkEditorApi<ImportedWorkDto> = {
  addSection: addImportedWorkSection,
  fetchUnit: fetchImportedWorkUnit,
  fetchWork: fetchImportedWork,
  saveContent: saveImportedWorkContent
};

type LoadState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; work: ImportedWorkDto }>;

export function ImportedWorkCorrectionPage({
  workEntryId
}: Readonly<{ workEntryId: string }>): React.JSX.Element {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    fetchImportedWork(workEntryId).then(
      (work) => {
        if (active) {
          setLoad({ status: "ready", work });
        }
      },
      () => {
        if (active) {
          setLoad({ status: "error" });
        }
      }
    );

    return () => {
      active = false;
    };
  }, [workEntryId]);

  if (load.status === "loading") {
    return (
      <EditorFrame>
        <LoadingIndicator label="Opening this work…" />
      </EditorFrame>
    );
  }

  if (load.status === "error") {
    return (
      <EditorFrame>
        <p className="text-text-muted" role="alert">
          Couldn&rsquo;t open this work for correction. It may have been removed, or its content
          isn&rsquo;t correctable here.
        </p>
      </EditorFrame>
    );
  }

  // "Open in Reader" jumps to how the corrected Work now reads, matching the Library's own read links.
  const openInReader = (
    <a
      className="text-sm font-medium text-accent hover:underline"
      href={`#/reader?work=${encodeURIComponent(load.work.entryId)}`}
    >
      Open in Reader
    </a>
  );

  return (
    <WorkContentEditor
      api={importedWorkEditorApi}
      key={load.work.entryId}
      leadingAction={openInReader}
      work={load.work}
    />
  );
}
