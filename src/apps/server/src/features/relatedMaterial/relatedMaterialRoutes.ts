import {
  parseRelatedMaterialRelationsRequest,
  parseRelatedMaterialSensesRequest,
  type RelatedMaterialRelationsResponse,
  type RelatedMaterialSenseDto,
  type RelatedMaterialSensesResponse
} from "@whetstone/contracts";
import { documentReadableText, type DocumentNodeJSON } from "@whetstone/document";
import type { FastifyInstance } from "fastify";

import type { DbClient } from "../../db/dbClient.js";
import type { LexicalRelationService } from "../lexical/lexicalRelationService.js";
import { enrichRelatedMaterialGroups } from "./relatedMaterialQuery.js";

const invalidRequest = { error: "invalid_request" } as const;

// The "Find related material" boundary (#716): expose the offline lexical service (#715) over two read-only,
// owner-scoped routes the New-card composer's inspection disclosure calls. Neither route writes anything, and
// neither participates in the save — related material is an inspection aid, never a duplicate/identity
// decision. The drafted Answer document is the only input; its surface and eligibility are projected
// server-side by the same rule the save applies, so the client never asserts eligibility.
export type RelatedMaterialRouteDependencies = Readonly<{
  db: DbClient;
  service: LexicalRelationService;
}>;

function toSenseDto(sense: {
  offset: string;
  partOfSpeech: RelatedMaterialSenseDto["partOfSpeech"];
  definition: string;
  examples: readonly string[];
  lemmas: readonly string[];
}): RelatedMaterialSenseDto {
  return {
    offset: sense.offset,
    partOfSpeech: sense.partOfSpeech,
    definition: sense.definition,
    examples: [...sense.examples],
    lemmas: [...sense.lemmas]
  };
}

export function registerRelatedMaterialRoutes(
  server: FastifyInstance,
  dependencies: RelatedMaterialRouteDependencies
): void {
  // Step 1 — list the drafted Answer's senses for EXPLICIT selection (#715 never auto-picks). 400 on a
  // malformed body; otherwise 200 with a status-typed outcome: `found` carries every sense, `not_found`/
  // `unsupported` are silent in the UI, `unavailable` (a genuine WordNet read failure) offers Retry and never
  // blocks the save. No related row is returned here — the learner must choose a sense first.
  server.post("/api/notes/review/related-material/senses", async (request, reply) => {
    let body;
    try {
      body = parseRelatedMaterialSensesRequest(request.body);
    } catch {
      return reply.code(400).send(invalidRequest);
    }
    const surface = documentReadableText(body.answerDoc as DocumentNodeJSON);
    const outcome = await dependencies.service.resolveSenses(surface);
    const response: RelatedMaterialSensesResponse =
      outcome.kind === "found"
        ? {
            status: "found",
            surface: outcome.value.surface,
            senses: outcome.value.senses.map(toSenseDto)
          }
        : { status: outcome.kind };
    return reply.code(200).send(response);
  });

  // Step 2 — the owner's related saved Notes under ONE selected sense. 400 on a malformed body; otherwise 200
  // with a status-typed outcome. `found` carries the normalized surface, the selected synset lemma, the
  // selected part of speech (for the "same {pos} lemma" reason and "born → bear · verb" header), and the typed
  // groups enriched with each note's saved word + capture context. The groups may be empty (a silent
  // no-result). The exact same surface is excluded by the service (it stays in exact material review), so
  // related material never doubles as a duplicate decision.
  server.post("/api/notes/review/related-material/relations", async (request, reply) => {
    let body;
    try {
      body = parseRelatedMaterialRelationsRequest(request.body);
    } catch {
      return reply.code(400).send(invalidRequest);
    }
    const surface = documentReadableText(body.answerDoc as DocumentNodeJSON);
    const outcome = await dependencies.service.relateNotes(
      dependencies.db,
      surface,
      body.sense,
      { userId: request.server.currentUser.getCurrentUserId() }
    );
    if (outcome.kind !== "found") {
      const response: RelatedMaterialRelationsResponse = { status: outcome.kind };
      return reply.code(200).send(response);
    }
    const groups = await enrichRelatedMaterialGroups(dependencies.db, outcome.value.groups);
    const response: RelatedMaterialRelationsResponse = {
      status: "found",
      surface: outcome.value.surface,
      selectedLemma: outcome.value.selectedLemma,
      partOfSpeech: body.sense.partOfSpeech,
      groups
    };
    return reply.code(200).send(response);
  });
}
