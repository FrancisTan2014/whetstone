import { toEntryId } from "@whetstone/domain";
import type { ExplainRequest } from "@whetstone/contracts";

import type { NoteDraft } from "../notes/noteCapture";

// Whether — and why not — the captured draft can become the Explain API's request (#925 correction):
// acceptance for what the SERVER will accept (the 300-code-unit `selectedText` cap, `explainContracts.ts`)
// is authoritative there, not duplicated here. A client-only rule here would drift from the real limit
// and, worse, silently remove the action for a selection the reader might reasonably want explained — so
// a merely-long selection is still `eligible`; the real backend's own 400/invalid-request response (on
// explicit invocation) is what surfaces actionable guidance for it. Only a genuinely non-representable
// capture — a cross-block span, which the single-block contract can never accept no matter its length —
// gets its own named `cross_block` outcome so the Reader can show a visible reason instead of a silently
// missing feature. An empty/whitespace-only selection is `none`: there is no real capture to explain.
export type ExplainEligibility =
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "cross_block" }>
  | Readonly<{ status: "eligible"; target: ExplainRequest }>;

// Derives the Explain API's exact request from the SAME captured draft the note/mark toolbar already
// uses (`noteCapture.ts`) — never a fresh re-read of the live DOM selection, never the whole Work or
// browsing history. Ordinary dictionary lookup is entirely unaffected by any of these outcomes.
export function deriveExplainEligibility(
  workEntryId: string,
  draft: NoteDraft
): ExplainEligibility {
  if (draft.endBlockEntryId !== undefined && draft.endBlockEntryId !== draft.blockEntryId) {
    return { status: "cross_block" };
  }

  const selectedText = draft.selectedText;
  if (selectedText.trim().length === 0) {
    return { status: "none" };
  }

  // A whole-single-block capture omits both offsets (`noteCapture.ts`): the draft covers the block's
  // entire plaintext, so the full-text range is reconstructed here rather than treating Explain as
  // ineligible for that common capture shape.
  const startOffset = draft.startOffset ?? 0;
  const endOffset = draft.endOffset ?? selectedText.length;

  return {
    status: "eligible",
    target: {
      blockEntryId: toEntryId(draft.blockEntryId),
      endOffset,
      selectedText,
      startOffset,
      workEntryId: toEntryId(workEntryId)
    }
  };
}
