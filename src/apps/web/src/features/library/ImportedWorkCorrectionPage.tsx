import { useCallback, useEffect, useRef, useState } from "react";

import type { ImportedWorkDto } from "@whetstone/contracts";

import type { ExtractionEvidenceMap } from "../../shared/editor/index.js";
import { Button } from "../../shared/ui/Button.js";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator.js";
import {
  addImportedWorkSection,
  fetchImportedWork,
  fetchImportedWorkUnit,
  saveImportedWorkContent
} from "./importedWorkApi.js";
import { fetchPdfExtractionEvidence } from "./pdfExtractionEvidenceApi.js";
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
  // The Work's SAFE PDF extraction evidence keyed by block id (#763), fetched alongside the Work and
  // refetched after each successful correction save so a just-corrected block's cue clears on the next
  // render. A non-PDF imported Work (or a 404) resolves to an empty map, so the editor simply shows no
  // evidence decoration. Fetched independently of the Work load so evidence never blocks opening.
  const [evidence, setEvidence] = useState<ExtractionEvidenceMap>(() => new Map());
  // Whether the LAST evidence load/refetch failed UNEXPECTEDLY — a 500/contract/network error, never the
  // inert 404/non-PDF path (which resolves to an empty map and never rejects). When true the page shows a
  // non-blocking retry affordance instead of silently presenting the failure as "no evidence"; a failed
  // fetch must never be indistinguishable from a Work that genuinely carries none (#763 review). Correction
  // itself is never blocked — the editor still opens; only the evidence guidance layer is degraded.
  const [evidenceError, setEvidenceError] = useState(false);

  // Guard evidence state updates against a fetch that settles after the page has unmounted.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshEvidence = useCallback((): void => {
    fetchPdfExtractionEvidence(workEntryId).then(
      (next) => {
        if (mountedRef.current) {
          setEvidence(next);
          setEvidenceError(false);
        }
      },
      () => {
        // The inert no-evidence path (a 404 or non-PDF Work) already resolved with an empty map above and
        // never rejects, so only an UNEXPECTED failure lands here. Keep whatever cues are already shown and
        // surface a retry rather than blanking them into a silent "no evidence".
        if (mountedRef.current) {
          setEvidenceError(true);
        }
      }
    );
  }, [workEntryId]);

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

  useEffect(() => {
    refreshEvidence();
  }, [refreshEvidence]);

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

  // A non-blocking retry surfaced only when an evidence load/refetch failed unexpectedly. Correction is
  // never blocked — the editor is fully usable; this just tells the administrator the guidance layer
  // could not load (rather than silently reading as "no evidence") and offers a one-click retry (#763).
  const leadingAction = (
    <div className="flex items-center gap-3">
      {openInReader}
      {evidenceError ? (
        <span className="flex items-center gap-2 text-sm text-warning" role="alert">
          <span>Extraction evidence couldn&rsquo;t load.</span>
          <Button onClick={refreshEvidence} size="sm" variant="secondary">
            Retry
          </Button>
        </span>
      ) : null}
    </div>
  );

  return (
    <WorkContentEditor
      api={importedWorkEditorApi}
      evidence={evidence}
      key={load.work.entryId}
      leadingAction={leadingAction}
      onContentSaved={refreshEvidence}
      work={load.work}
    />
  );
}
