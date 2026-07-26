import type {
  McpPreviewCardResult,
  McpRelatedMaterial,
  MaterialReviewCandidateDto,
  NearMaterialReviewCandidateDto,
  NoteGradingTarget,
  RelatedMaterialRelationsResponse,
  RelatedMaterialSenseDto,
  RelatedMaterialSenseRef,
  RelatedMaterialSensesResponse
} from "@whetstone/contracts";
import { type DocumentNodeJSON } from "@whetstone/document";

import type { DbClient } from "../../db/dbClient.js";
import type { LexicalRelationService } from "../lexical/lexicalRelationService.js";
import { findNearMatchNotes } from "../notes/noteNearMatchQuery.js";
import { findExactMaterialNotes } from "../notes/noteQueries.js";
import { enrichRelatedMaterialGroups } from "../relatedMaterial/relatedMaterialQuery.js";
import {
  expireCardCreationAttempts,
  fingerprintReviewCandidates,
  getPendingAttemptForSubmission,
  insertPendingCardCreationAttempt,
  refreshAttemptReview,
  type CardCreationAttemptRecord
} from "./cardCreationAttemptStore.js";
import { prepareDirectCardDraft, type PreparedDirectCardDraft } from "./createDirectCard.js";
import {
  loadMaterialReviewCandidates,
  loadNearMaterialReviewCandidates
} from "./materialReviewCandidates.js";

// The shared server-boundary PREVIEW command behind the local-MCP `preview_card_creation` tool (#717). It runs
// the SAME validation/matching a New-card save runs — reusing `prepareDirectCardDraft`, the exact/near
// matchers, the candidate enrichment, and the offline lexical service — but it NEVER writes learning state.
// Every previewable draft stages exactly one opaque, expiring `card_creation_attempt` (source `mcp`) and
// returns the rendered card plus its corpus evidence for a later, human-approved commit. No note, prompt,
// card, event, link, or receipt is created — a preview is inspection, never a decision. The command is the
// single place this behavior lives; the MCP transport only wraps text into documents and serializes the
// result.

// What a preview needs: the database, id generation for the staged attempt, an explicit clock so the attempt's
// expiry is deterministic, the attempt TTL, and the offline lexical service for the optional related-material
// evidence.
export type PreviewCardCreationDependencies = Readonly<{
  attemptTtlMs: number;
  createId: () => string;
  db: DbClient;
  lexical: LexicalRelationService;
  now: () => Date;
}>;

// One drafted preview request. `submissionId` is the caller-stable replay key (the MCP `requestId`); the two
// documents and the grading target are the wrapped plain-text fields; `sense` is the optional explicitly
// selected WordNet sense the related-material step relates from (null = list the senses to choose).
export type PreviewCardCreationRequest = Readonly<{
  submissionId: string;
  questionDoc: DocumentNodeJSON;
  answerDoc: DocumentNodeJSON;
  target: NoteGradingTarget;
  sense: RelatedMaterialSenseRef | null;
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

// Resolve the optional lexical evidence attached to a preview, reusing the SAME offline service and enrichment
// the HTTP "Find related material" routes use (#716) — MCP re-derives no lexical policy. With no selected
// sense, return the drafted Answer's senses to choose from (mode `senses`); with a selected sense, return the
// owner's related saved notes under it (mode `relations`). Read-only and offline, so it runs outside the
// staging transaction. A non-eligible Answer simply yields an `unsupported`/`not_found` status inside the
// reused outcome — never an error.
async function buildRelatedMaterial(
  dependencies: PreviewCardCreationDependencies,
  surface: string,
  sense: RelatedMaterialSenseRef | null,
  userId: string
): Promise<McpRelatedMaterial> {
  if (sense === null) {
    const outcome = await dependencies.lexical.resolveSenses(surface);
    const senses: RelatedMaterialSensesResponse =
      outcome.kind === "found"
        ? { status: "found", surface: outcome.value.surface, senses: outcome.value.senses.map(toSenseDto) }
        : { status: outcome.kind };
    return { mode: "senses", senses };
  }
  const outcome = await dependencies.lexical.relateNotes(dependencies.db, surface, sense, { userId });
  if (outcome.kind !== "found") {
    const relations: RelatedMaterialRelationsResponse = { status: outcome.kind };
    return { mode: "relations", relations };
  }
  const groups = await enrichRelatedMaterialGroups(dependencies.db, outcome.value.groups, {
    userId
  });
  const relations: RelatedMaterialRelationsResponse = {
    status: "found",
    surface: outcome.value.surface,
    selectedLemma: outcome.value.selectedLemma,
    partOfSpeech: sense.partOfSpeech,
    groups
  };
  return { mode: "relations", relations };
}

// Assemble the `previewed` result the client must present verbatim for learner approval: the opaque attempt id
// and its expiry, the fixed approval gate and safe next action, the server-derived rendered card (Question,
// Answer, and the Success check text only when the draft grades against one), the two typed candidate groups,
// the attempt's own candidate fingerprint/revision, and the optional lexical evidence.
function buildPreviewedResult(
  attempt: CardCreationAttemptRecord,
  draft: PreparedDirectCardDraft,
  candidates: ReadonlyArray<MaterialReviewCandidateDto>,
  nearCandidates: ReadonlyArray<NearMaterialReviewCandidateDto>,
  relatedMaterial: McpRelatedMaterial
): McpPreviewCardResult {
  return {
    status: "previewed",
    attemptId: attempt.id,
    expiresAt: attempt.expiresAt.toISOString(),
    approvalRequired: true,
    nextAction: "present_preview_and_request_approval",
    renderedCard: {
      question: draft.cueText,
      answer: draft.bodyText,
      successCheck:
        draft.reveal.revealKind === "expected_response" ? draft.reveal.answerText : null
    },
    candidates: [...candidates],
    nearCandidates: [...nearCandidates],
    candidateFingerprint: attempt.candidateFingerprint,
    revision: attempt.revision,
    relatedMaterial
  };
}

// Preview one corpus-grounded card (#717). Validates and projects the draft at the same boundary a save uses;
// a document whose derived text is only whitespace, or an invalid Success check, is rejected as the matching
// `invalid_*` outcome before anything is staged or matched. Otherwise the command stages exactly one opaque,
// expiring attempt (source `mcp`, with the exact drafted documents kept for a later commit) and returns the
// rendered card, its exact/near corpus candidates, and the optional lexical evidence — WITHOUT writing any
// note, prompt, card, event, link, or receipt.
//
// Idempotency is keyed by `requestId` -> `submissionId`, mirroring the save's replay rules: an expired attempt
// for the same request is swept first (never resurrected); a still-live pending attempt bound to the SAME
// draft replays that attempt (refreshing its candidate evidence under the revision fence when the corpus
// changed); a pending attempt bound to a DIFFERENT draft is a `changed_payload` conflict the caller must
// resolve with a fresh request id. Staging, matching, and the replay check run in ONE transaction so the
// returned candidate fingerprint reflects a single corpus snapshot. The lexical evidence is resolved outside
// that transaction (read-only, offline).
export async function previewCardCreation(
  dependencies: PreviewCardCreationDependencies,
  userId: string,
  request: PreviewCardCreationRequest
): Promise<McpPreviewCardResult> {
  const prepared = prepareDirectCardDraft(request);
  if (prepared.status !== "ok") {
    return { status: prepared.status };
  }
  const draft = prepared.draft;
  const now = dependencies.now();

  const relatedMaterial = await buildRelatedMaterial(
    dependencies,
    draft.bodyText,
    request.sense,
    userId
  );

  return dependencies.db.transaction(async (tx) => {
    // Sweep an expired same-request attempt before staging, so a lapsed preview never blocks a fresh one on the
    // partial-unique (owner, submission) index and can never be resurrected as a live attempt.
    await expireCardCreationAttempts(tx, now);

    const pending = await getPendingAttemptForSubmission(tx, userId, request.submissionId);
    const matches = await findExactMaterialNotes(tx, { bodyDoc: draft.answerDoc, userId });
    const near = await findNearMatchNotes(tx, { bodyDoc: draft.answerDoc, userId });
    const exactNoteIds = matches.map((note) => note.noteEntryId);
    const nearNoteIds = near.map((note) => note.noteEntryId);
    const nearKeys = near.map((note) => note.caseSensitiveKey);
    const candidates = await loadMaterialReviewCandidates(tx, userId, matches);
    const nearCandidates = await loadNearMaterialReviewCandidates(tx, userId, draft.answerDoc, near);

    if (pending !== null) {
      // A still-live preview for this request whose draft has since changed is a conflict, not a silent
      // overwrite: the caller must mint a fresh request id rather than mutate a staged preview under the same
      // id (which would let a later commit act on a draft the caller no longer sees).
      if (pending.draftFingerprint !== draft.fingerprint) {
        return { status: "changed_payload" };
      }
      // Same request, same draft: replay the same live attempt, refreshing its persisted candidates (and
      // bumping the fence) only when the corpus evidence changed, so the returned revision is exactly current.
      const changed =
        fingerprintReviewCandidates({ exactNoteIds, nearKeys, nearNoteIds }) !==
        pending.candidateFingerprint;
      let attempt = pending;
      if (changed) {
        const refreshed = await refreshAttemptReview(tx, {
          exactNoteIds,
          expectedRevision: pending.revision,
          id: pending.id,
          nearKeys,
          nearNoteIds,
          now,
          userId
        });
        /* v8 ignore next -- refreshAttemptReview only misses under a concurrent decision on this attempt;
           stdio previews are serialized, so the `?? pending` fallback merely keeps the type total. */
        attempt = refreshed ?? pending;
      }
      return buildPreviewedResult(attempt, draft, candidates, nearCandidates, relatedMaterial);
    }

    const attempt = await insertPendingCardCreationAttempt(tx, {
      draftFingerprint: draft.fingerprint,
      draftPayload: {
        answerDoc: draft.answerDoc,
        questionDoc: draft.questionDoc,
        target: request.target
      },
      exactNoteIds,
      expiresAt: new Date(now.getTime() + dependencies.attemptTtlMs),
      id: dependencies.createId(),
      nearKeys,
      nearNoteIds,
      now,
      source: "mcp",
      submissionId: request.submissionId,
      userId
    });
    return buildPreviewedResult(attempt, draft, candidates, nearCandidates, relatedMaterial);
  });
}
