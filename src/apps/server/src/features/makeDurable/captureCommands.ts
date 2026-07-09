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
  selectPolicyExamples,
  type ExistingRecallItem
} from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import { listRecallItems } from "../recall/recallQueries.js";
import { countVisibleCandidates, MAKE_DURABLE_TODAY_CARD_CAP } from "./cardQueries.js";
import { insertProposalCandidate } from "./proposalCommands.js";
import { listReviewedProposalExamples, POLICY_REVIEW_LOOKBACK } from "./proposalQueries.js";
import type { ProposalAttempt, ProposalProvider } from "./proposalProvider.js";
import { createTimelineCapture } from "./timelineCommands.js";

// Everything the Quick Capture command needs: id/db/clock plus the proposal seam (the local model,
// faked in tests). `confidenceThreshold` is optional so the domain default is used in production.
export type QuickCaptureDependencies = Readonly<{
  confidenceThreshold?: number;
  createId: () => string;
  db: DbClient;
  now: () => Date;
  propose: ProposalProvider;
  // Interactive budget (ms) for the best-effort proposal seam (#554). Quick Capture saves the Timeline
  // entry first and must return promptly, so it waits at most this long for the local model; a stalled
  // or slow daemon is abandoned and the capture degrades to no card rather than blocking. Optional so
  // production uses `QUICK_CAPTURE_PROPOSAL_TIMEOUT_MS`; tests inject a tiny budget.
  proposalTimeoutMs?: number;
  // Offline gloss autofill (#526): threaded to `saveProposalRecallItem` so a saved `phrase` proposal
  // with no explanation still gets a back auto-filled from the bundled dictionaries. Optional; absent
  // means no autofill.
  resolveOfflineGloss?: (text: string) => Promise<string | null>;
}>;

export type CaptureProposalDependencies = Pick<
  QuickCaptureDependencies,
  | "confidenceThreshold"
  | "createId"
  | "db"
  | "propose"
  | "proposalTimeoutMs"
  | "resolveOfflineGloss"
>;

// The interactive Quick Capture proposal budget (#554). The shared `LlmModel` seam already hard-bounds a
// stalled daemon at 60s, but that ceiling is a background safety net, not an interactive one: waiting it
// out would hang the capture. This shorter wall-clock bound keeps the typed/voice capture responsive —
// a fast local model still returns a card within it, while a slow or unresponsive daemon is abandoned so
// the capture returns promptly with no card (the Timeline entry is already saved). Injectable via
// `QuickCaptureDependencies.proposalTimeoutMs`; tests inject a tiny value.
export const QUICK_CAPTURE_PROPOSAL_TIMEOUT_MS = 8_000;

// Sentinel resolved by the budget timer, so a timed-out proposal is distinguished from a model that
// genuinely returned `null` (unavailable / no candidate) — both degrade to no card, but only the former
// leaves the abandoned generation running.
const PROPOSAL_TIMED_OUT = Symbol("proposal_timed_out");

// Wait at most `budgetMs` for the best-effort proposal. Resolves with the model's attempt (or its `null`)
// when it wins, or the `PROPOSAL_TIMED_OUT` sentinel when the budget elapses first. The provider never
// rejects (its contract degrades every failure to `null`), and `Promise.race` keeps a handler attached to
// the generation, so an abandoned generation never surfaces an unhandled rejection.
async function proposeWithinBudget(
  generation: Promise<ProposalAttempt | null>,
  budgetMs: number
): Promise<ProposalAttempt | null | typeof PROPOSAL_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<typeof PROPOSAL_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(PROPOSAL_TIMED_OUT), budgetMs);
  });

  try {
    return await Promise.race([generation, budget]);
  } finally {
    clearTimeout(timer);
  }
}

// Build a Today review card from an inserted candidate DTO + its (already schema-valid) payload. Shared
// by Quick Capture and the backfill scan so both surface the identical card shape.
export function toReviewCard(
  candidate: ProposalCandidateDto,
  payload: ProposalPayload
): MakeDurableCardDto {
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

// Run the Make Durable proposal path for an already-persisted capture. Shared by legacy Quick Capture
// and the unified Diary capture: persistence happens first, then this best-effort proposal pass may
// insert at most one candidate and return at most one visible Today review card.
export async function proposeForCapture(
  dependencies: CaptureProposalDependencies,
  rawText: string,
  userId: string,
  timelineEntryId: string,
  now: Date
): Promise<MakeDurableCardDto | null> {
  const md = { createId: dependencies.createId, db: dependencies.db };

  // Retrieve-before-generate (#452): load a small slice of the learner's existing recall FIRST, so the
  // proposal seam can compare against it in the prompt and prefer no candidate when already covered. The
  // same retrieved set feeds the deterministic duplicate gate below as the safety net.
  const existing: ReadonlyArray<ExistingRecallItem> = (
    await listRecallItems(dependencies.db, userId)
  ).map((item) => ({ target: item.text, useContext: item.useContext }));

  // Reviewed-example policy (#457): pull the learner's recent proposal reviews and narrow them to a
  // bounded, type-diverse few-shot set so the model follows past accept/skip/type decisions. Empty when
  // there is no review history, which falls back to the pre-policy prompt.
  const examples = selectPolicyExamples(
    await listReviewedProposalExamples(dependencies.db, userId, POLICY_REVIEW_LOOKBACK)
  );

  // Best-effort proposal, time-boxed (#554): wait at most the interactive budget for the local model.
  // A stalled/slow daemon (or a model that returns nothing) degrades to no card — the Timeline entry is
  // already saved — so the capture never blocks. The abandoned generation is left to settle harmlessly.
  const outcome = await proposeWithinBudget(
    dependencies.propose(rawText, existing, examples),
    dependencies.proposalTimeoutMs ?? QUICK_CAPTURE_PROPOSAL_TIMEOUT_MS
  );
  const attempt = outcome === PROPOSAL_TIMED_OUT ? null : outcome;
  const generated = attempt?.generation.candidates[0];
  if (attempt === null || generated === undefined) {
    return null;
  }

  const gate = evaluateProposalGate({
    confidence: generated.confidence,
    evidenceQuote: generated.evidenceQuote,
    rawText,
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
    timelineEntryId,
    type: generated.type
  };
  const candidate = await insertProposalCandidate(md, candidateRequest, userId, now);

  if (status !== "visible") {
    return null;
  }

  return toReviewCard(candidate, generated.payload);
}

// Quick Capture (#452, #455). The Timeline entry is saved FIRST and is never lost: only after it is
// persisted does the proposal seam run, and any failure there (model down, timeout, invalid output)
// simply yields no card. The proposal wait is time-boxed to an interactive budget (#554): a stalled or
// slow local daemon is abandoned so the capture returns promptly with the saved entry and no card,
// never blocking on the model. A capture may be typed or voice (`request.inputMode`); a voice capture
// submits its transcript as the text and follows the exact same path from here on. When a candidate is
// produced it is gated (confidence + faithful evidence quote) and deduped against the user's recall
// items; it is stored either `visible` (a card is returned) or `dismissed` (gated out / duplicate — no
// card). At most one candidate per capture, so the "one card per capture" rule holds by construction.
export async function quickCapture(
  dependencies: QuickCaptureDependencies,
  request: QuickCaptureRequest,
  userId: string,
  now: Date
): Promise<QuickCaptureResultDto> {
  const md = { createId: dependencies.createId, db: dependencies.db };

  const captureRequest: CreateTimelineCaptureRequest = {
    captureSource: "quick_capture",
    inputMode: request.inputMode,
    language: null,
    rawAudioPath: null,
    rawInputText: request.text,
    tidiedText: null
  };
  const timelineEntry = await createTimelineCapture(md, captureRequest, userId, now);

  return {
    card: await proposeForCapture(dependencies, request.text, userId, timelineEntry.entryId, now),
    timelineEntry
  };
}
