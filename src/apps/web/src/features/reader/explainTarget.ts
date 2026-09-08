import { toEntryId } from "@whetstone/domain";
import type { ExplainRequest } from "@whetstone/contracts";

import type { NoteDraft } from "../notes/noteCapture";

// The same 300-code-unit cap the shared contract enforces on `selectedText` (`explainContracts.ts`).
// Duplicated here (not imported) because it is a UI-eligibility check, not a validation the server
// re-runs: a selection over the cap is simply never offered Explain, rather than sent and rejected.
const MAX_EXPLAIN_SELECTION_LENGTH = 300;

// Derives the Explain API's exact request from the SAME captured draft the note/mark toolbar already
// uses (`noteCapture.ts`) — never a fresh re-read of the live DOM selection, never the whole Work or
// browsing history. Returns undefined when the draft cannot become a valid, single-block
// `ExplainRequest`: a cross-block span (the contract is single-block only, #924), an empty selection,
// or one over the shared selection-length cap. The Reader still offers ordinary dictionary lookup in
// every one of these ineligible cases — Explain simply does not appear.
export function deriveExplainTarget(
  workEntryId: string,
  draft: NoteDraft
): ExplainRequest | undefined {
  if (draft.endBlockEntryId !== undefined && draft.endBlockEntryId !== draft.blockEntryId) {
    return undefined;
  }

  const selectedText = draft.selectedText;
  if (selectedText.trim().length === 0 || selectedText.length > MAX_EXPLAIN_SELECTION_LENGTH) {
    return undefined;
  }

  // A whole-single-block capture omits both offsets (`noteCapture.ts`): the draft covers the block's
  // entire plaintext, so the full-text range is reconstructed here rather than treating Explain as
  // ineligible for that common capture shape.
  const startOffset = draft.startOffset ?? 0;
  const endOffset = draft.endOffset ?? selectedText.length;

  return {
    blockEntryId: toEntryId(draft.blockEntryId),
    endOffset,
    selectedText,
    startOffset,
    workEntryId: toEntryId(workEntryId)
  };
}
