import {
  parseRelatedMaterialRelationsResponse,
  parseRelatedMaterialSensesResponse,
  type CreateDirectCardRequest,
  type RelatedMaterialRelationsResponse,
  type RelatedMaterialSenseRef,
  type RelatedMaterialSensesResponse
} from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

// The New-card "Find related material" fetch helpers (#716). Both expose the offline lexical service (#715)
// as a pure INSPECTION aid: they never mutate anything and their failure is never fatal to the save. A lost
// response or a non-2xx status is folded into the `unavailable` status the disclosure already renders (it
// offers Retry), so a transport hiccup can never masquerade as "no related material" or block card creation.
// Every success is parsed through the shared contracts schema so a drifted server shape is caught at the
// boundary rather than surfacing as a render-time crash.
const jsonHeaders = { "content-type": "application/json" } as const;

// Step 1: the WordNet senses of the drafted Answer, so the learner can pick one explicitly (#715 never
// auto-picks). Only the Answer document is sent; the surface and eligibility are projected server-side.
export async function fetchRelatedSenses(
  answerDoc: CreateDirectCardRequest["answerDoc"]
): Promise<RelatedMaterialSensesResponse> {
  let response: Response;
  try {
    response = await fetch(apiUrl("/notes/review/related-material/senses"), {
      body: JSON.stringify({ answerDoc }),
      headers: jsonHeaders,
      method: "POST"
    });
  } catch {
    return { status: "unavailable" };
  }
  if (!response.ok) {
    return { status: "unavailable" };
  }
  return parseRelatedMaterialSensesResponse(await response.json());
}

// Step 2: the owner's typed related saved Notes under one selected sense. The surface is re-projected from
// `answerDoc` server-side; `sense` names which synset to relate from.
export async function fetchRelatedRelations(
  answerDoc: CreateDirectCardRequest["answerDoc"],
  sense: RelatedMaterialSenseRef
): Promise<RelatedMaterialRelationsResponse> {
  let response: Response;
  try {
    response = await fetch(apiUrl("/notes/review/related-material/relations"), {
      body: JSON.stringify({ answerDoc, sense }),
      headers: jsonHeaders,
      method: "POST"
    });
  } catch {
    return { status: "unavailable" };
  }
  if (!response.ok) {
    return { status: "unavailable" };
  }
  return parseRelatedMaterialRelationsResponse(await response.json());
}
