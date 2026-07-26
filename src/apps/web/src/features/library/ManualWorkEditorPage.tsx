import { useEffect, useState } from "react";

import type { ManualWorkDto } from "@whetstone/contracts";

import { LoadingIndicator } from "../../shared/ui/LoadingIndicator.js";
import {
  addManualWorkSection,
  fetchManualWork,
  fetchManualWorkUnit,
  saveManualWorkContent
} from "./manualWorkApi.js";
import type { WorkEditorApi } from "./workContentEditor.js";
import { EditorFrame, WorkContentEditor } from "./workContentEditor.js";

// The Library manual-Work editor page (#720, live Outline #697): the thin loader a learner reaches from a
// manual Work's "Edit content" action. It fetches the owner-scoped Work, then hands it to the shared
// `WorkContentEditor` with the manual API adapter. The editing surface, Outline, revision fence, and
// conflict/draft behavior all live in the shared editor (reused verbatim by the imported-correction page,
// #762); only the DATA ACCESS differs here — the manual endpoints authorize the OWNER, so this page stays
// the owner-scoped entry point and never gains administrative reach.

// Bind the shared editor to the manual endpoints. The manual DTO is a structural superset of the shared
// editor's `WorkEditorWork`, so it satisfies the API contract without the editor knowing the origin.
const manualWorkEditorApi: WorkEditorApi<ManualWorkDto> = {
  addSection: addManualWorkSection,
  fetchUnit: fetchManualWorkUnit,
  fetchWork: fetchManualWork,
  saveContent: saveManualWorkContent
};

type LoadState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; work: ManualWorkDto }>;

export function ManualWorkEditorPage({
  workEntryId
}: Readonly<{ workEntryId: string }>): React.JSX.Element {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    fetchManualWork(workEntryId).then(
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
          Couldn&rsquo;t open this work. It may have been removed, or it isn&rsquo;t one you can
          edit.
        </p>
      </EditorFrame>
    );
  }

  return <WorkContentEditor api={manualWorkEditorApi} key={load.work.entryId} work={load.work} />;
}
