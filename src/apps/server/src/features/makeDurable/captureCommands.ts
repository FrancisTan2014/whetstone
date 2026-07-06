import type {
  CreateProposalCandidateRequest,
  CreateTimelineCaptureRequest,
  JsonObject,
  MakeDurableCardDto,
  ProposalCandidateDto,
  ProposalCandidateStatus,
  ProposalPayload,
  QuickCaptureRequest,
  QuickCaptureResultDto
} from "@whetstone/contracts";
import {
  classifyProposalDuplicate,
  DEFAULT_PROPOSAL_CONFIDENCE_THRESHOLD,
  evaluateProposalGate,
  PROPOSAL_PROMPT_VERSION,
  type ExistingRecallItem
} from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import { listRecallItems } from "../recall/recallQueries.js";
import { countVisibleCandidates, MAKE_DURABLE_TODAY_CARD_CAP } from "./cardQueries.js";
import { insertProposalCandidate } from "./proposalCommands.js";
import type { ProposalProvider } from "./proposalProvider.js";
import { createTimelineCapture } from "./timelineCommands.js";

// Everything the Quick Capture command needs: id/db/clock plus the proposal seam (the local model,
// faked in tests). `confidenceThreshold` is optional so the domain default is used in production.
export type QuickCaptureDependencies = Readonly<{
  confidenceThreshold?: number;
  createId: () => string;
  db: DbClient;
  now: () => Date;
  propose: ProposalProvider;
}>;

function toCard(candidate: ProposalCandidateDto, payload: ProposalPayload): MakeDurableCardDto {
  return {
    proposalCandidateId: candidate.id,
    timelineEntryId: candidate.timelineEntryId,
    type: candidate.type,
    target: payload.target,
    cue: payload.cue,
    useContext: payload.useContext,
    reason: candidate.reason,
    category: payload.category,
    tags: payload.tags ?? []
  };
}

// Typed Quick Capture (#452). The Timeline entry is saved FIRST and is never lost: only after it is
// persisted does the proposal seam run, and any failure there (model down, timeout, invalid output)
// simply yields no card. When a candidate is produced it is gated (confidence + faithful evidence quote)
// and deduped against the user's recall items; it is stored either `visible` (a card is returned) or
// `dismissed` (gated out / duplicate — no card). At most one candidate per capture, so the "one card per
// capture" rule holds by construction.
export async function quickCapture(
  dependencies: QuickCaptureDependencies,
  request: QuickCaptureRequest,
  userId: string,
  now: Date
): Promise<QuickCaptureResultDto> {
  const md = { createId: dependencies.createId, db: dependencies.db };

  const captureRequest: CreateTimelineCaptureRequest = {
    captureSource: "quick_capture",
    inputMode: "typed",
    language: null,
    rawAudioPath: null,
    rawInputText: request.text,
    tidiedText: null
  };
  const timelineEntry = await createTimelineCapture(md, captureRequest, userId, now);

  // Retrieve-before-generate (#452): load a small slice of the learner's existing recall FIRST, so the
  // proposal seam can compare against it in the prompt and prefer no candidate when already covered. The
  // same retrieved set feeds the deterministic duplicate gate below as the safety net.
  const existing: ReadonlyArray<ExistingRecallItem> = (
    await listRecallItems(dependencies.db, userId)
  ).map((item) => ({ target: item.text, useContext: item.useContext }));

  const attempt = await dependencies.propose(request.text, existing);
  const generated = attempt?.generation.candidates[0];
  if (attempt === null || generated === undefined) {
    return { card: null, timelineEntry };
  }

  const gate = evaluateProposalGate({
    confidence: generated.confidence,
    evidenceQuote: generated.evidenceQuote,
    rawText: request.text,
    threshold: dependencies.confidenceThreshold ?? DEFAULT_PROPOSAL_CONFIDENCE_THRESHOLD
  });

  const duplicateStatus = classifyProposalDuplicate(
    { target: generated.payload.target, useContext: generated.payload.useContext },
    existing
  );

  // Three outcomes: a candidate that fails the gate or duplicates an existing item is `dismissed`; one
  // that qualifies but would be the SECOND card on Today (the one-card cap is already reached) is held
  // `pending` (surfaced later when the current card is reviewed); otherwise it is `visible` with a card.
  const gatedIn = gate.visible && duplicateStatus !== "same_target_same_context";
  const atCap =
    (await countVisibleCandidates(dependencies.db, userId)) >= MAKE_DURABLE_TODAY_CARD_CAP;
  const status: ProposalCandidateStatus = !gatedIn ? "dismissed" : atCap ? "pending" : "visible";

  const candidateRequest: CreateProposalCandidateRequest = {
    confidence: generated.confidence,
    duplicateStatus,
    evidenceQuote: generated.evidenceQuote,
    modelName: attempt.modelName,
    payload: generated.payload as JsonObject,
    promptVersion: PROPOSAL_PROMPT_VERSION,
    reason: generated.reason,
    relatedRecallItemId: null,
    noveltyReason: null,
    status,
    timelineEntryId: timelineEntry.entryId,
    type: generated.type
  };
  const candidate = await insertProposalCandidate(md, candidateRequest, userId, now);

  if (status !== "visible") {
    return { card: null, timelineEntry };
  }

  return { card: toCard(candidate, generated.payload), timelineEntry };
}
