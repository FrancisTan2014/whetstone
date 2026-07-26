import {
  parseRelatedMaterialRelationsResponse,
  parseRelatedMaterialSensesResponse,
  type RelatedMaterialRelationsResponse,
  type RelatedMaterialSenseRef,
  type RelatedMaterialSensesResponse
} from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";

import { apiUrl } from "../../shared/runtime";

// The "Find related material" fetch boundary (#716). It calls #772's two read-only, owner-scoped routes the
// New-card disclosure drives: list the drafted Answer's senses, then — under one explicitly selected sense —
// the owner's typed related saved Notes. Neither call writes anything, and neither participates in the save.
//
// Both routes answer 200 with a status-typed outcome (`found | not_found | unsupported | unavailable`). A
// transport failure, a non-2xx, or a drifted body all resolve to the retryable `unavailable` status — never
// silence and never a thrown error — so a broken request offers Retry and never blocks the save, exactly as
// a genuine WordNet read failure does.
const jsonHeaders = { "content-type": "application/json" } as const;

// Step 1 — the drafted Answer's senses for EXPLICIT selection. Only the Answer document is sent; the server
// reprojects its surface and eligibility, so the client never asserts either.
export async function fetchRelatedSenses(
  answerDoc: DocumentNodeJSON
): Promise<RelatedMaterialSensesResponse> {
  try {
    const response = await fetch(apiUrl("/notes/review/related-material/senses"), {
      body: JSON.stringify({ answerDoc }),
      headers: jsonHeaders,
      method: "POST"
    });
    if (!response.ok) {
      return { status: "unavailable" };
    }
    return parseRelatedMaterialSensesResponse(await response.json());
  } catch {
    return { status: "unavailable" };
  }
}

// Step 2 — the owner's related saved Notes for the drafted Answer under ONE selected sense. The surface is
// reprojected from `answerDoc` server-side; `sense` names which synset to relate from.
export async function fetchRelatedRelations(
  answerDoc: DocumentNodeJSON,
  sense: RelatedMaterialSenseRef
): Promise<RelatedMaterialRelationsResponse> {
  try {
    const response = await fetch(apiUrl("/notes/review/related-material/relations"), {
      body: JSON.stringify({ answerDoc, sense }),
      headers: jsonHeaders,
      method: "POST"
    });
    if (!response.ok) {
      return { status: "unavailable" };
    }
    return parseRelatedMaterialRelationsResponse(await response.json());
  } catch {
    return { status: "unavailable" };
  }
}
