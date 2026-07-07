import type {
  BackfillResultDto,
  CreateProposalCandidateRequest,
  JsonObject,
  ProposalCandidateStatus
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
import { toReviewCard } from "./captureCommands.js";
import { insertProposalCandidate } from "./proposalCommands.js";
import { listReviewedProposalExamples, POLICY_REVIEW_LOOKBACK } from "./proposalQueries.js";
import type { ProposalProvider } from "./proposalProvider.js";
import { listBackfillableCaptures, recordBackfillScan } from "./timelineQueries.js";

// How many prior Timeline entries a single backfill run may consider (#456). The scan is bounded so a
// manual trigger never turns into a bulk mining job: it stops at the first high-value proposal, or after
// examining this many un-mined entries.
export const BACKFILL_SCAN_LIMIT = 25;

// Everything the backfill command needs: id/db/clock plus the BACKFILL proposal seam (the high-value
// prompt, faked in tests). `confidenceThreshold` is optional so the domain default is used in production.
export type BackfillDependencies = Readonly<{
  confidenceThreshold?: number;
  createId: () => string;
  db: DbClient;
  now: () => Date;
  proposeBackfill: ProposalProvider;
}>;

// A bounded Make Durable backfill scan (#456): mine the user's existing Timeline history for ONE
// high-value Recall proposal, reusing the exact live-capture machinery — the same proposal seam (the
// backfill provider swaps in a high-value prompt), retrieve-before-generate context, visibility gate,
// duplicate suppression, one-card cap, and candidate store. It is calm and bounded: it only considers
// the current user's entries that have no candidate yet (oldest first), stops at the first gated-in
// proposal, and surfaces at most one visible Today card per run. The model is never allowed to break
// Today — a null attempt (model down/timeout) stops the scan and leaves history unchanged.
export async function backfillMakeDurable(
  dependencies: BackfillDependencies,
  userId: string,
  now: Date
): Promise<BackfillResultDto> {
  const md = { createId: dependencies.createId, db: dependencies.db };
  const threshold = dependencies.confidenceThreshold ?? DEFAULT_PROPOSAL_CONFIDENCE_THRESHOLD;

  // Retrieve-before-generate: load the learner's existing recall ONCE. The scan saves nothing to recall
  // (a save happens later, on user review), so this set is stable and feeds both the prompt and the
  // deterministic duplicate gate for every entry examined this run.
  const existing: ReadonlyArray<ExistingRecallItem> = (
    await listRecallItems(dependencies.db, userId)
  ).map((item) => ({ target: item.text, useContext: item.useContext }));

  // Reviewed-example policy (#457): the same bounded, type-diverse few-shot set the live capture uses, so
  // backfill proposals also follow the learner's past accept/skip/type decisions. Loaded once for the run.
  const examples = selectPolicyExamples(
    await listReviewedProposalExamples(dependencies.db, userId, POLICY_REVIEW_LOOKBACK)
  );

  const captures = await listBackfillableCaptures(dependencies.db, userId, BACKFILL_SCAN_LIMIT);

  let scannedCount = 0;
  for (const capture of captures) {
    const attempt = await dependencies.proposeBackfill(capture.rawInputText, existing, examples);
    // Model unavailable/slow/invalid output: stop and leave history unchanged from here on. When the
    // model is down this happens on the first entry, so scannedCount stays 0 (history untouched).
    if (attempt === null) {
      break;
    }
    scannedCount += 1;

    const generated = attempt.generation.candidates[0];
    // The model found nothing worth keeping in this entry: record a durable "evaluated, no proposal"
    // marker so the bounded scan advances past it on later runs (otherwise the first `BACKFILL_SCAN_LIMIT`
    // empty entries would be re-selected forever and hide a high-value entry beyond them), then keep
    // scanning for a better one this run.
    if (generated === undefined) {
      await recordBackfillScan(dependencies.db, capture.entryId, userId, now);
      continue;
    }

    const gate = evaluateProposalGate({
      confidence: generated.confidence,
      evidenceQuote: generated.evidenceQuote,
      rawText: capture.rawInputText,
      threshold
    });
    const duplicateStatus = classifyProposalDuplicate(
      { target: generated.payload.target, useContext: generated.payload.useContext },
      existing
    );

    // Identical outcome logic to Quick Capture: a candidate that fails the gate or duplicates existing
    // recall is `dismissed` (recorded so the entry is never re-mined); one that qualifies is `visible`,
    // or held `pending` when Today already shows a card (the one-card cap), so backfill adds at most one
    // visible card per run.
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
      timelineEntryId: capture.entryId,
      type: generated.type
    };
    const candidate = await insertProposalCandidate(md, candidateRequest, userId, now);

    if (status === "visible") {
      return { card: toReviewCard(candidate, generated.payload), scannedCount };
    }
    if (status === "pending") {
      // We produced one gated-in proposal but Today already holds a card, so it is held, not shown, and
      // the run stops — one proposal per run, at most one visible card.
      return { card: null, scannedCount };
    }
    // dismissed: this entry offered nothing durable; keep scanning within the bound.
  }

  return { card: null, scannedCount };
}
