import { proposalGenerationSchema, type ProposalGeneration } from "@whetstone/contracts";
import {
  buildBackfillProposalPrompt,
  buildProposalPrompt,
  type ExistingRecallItem
} from "@whetstone/domain";

import type { LlmModel } from "../../llm/llmModel.js";

// The Make Durable proposal seam (#452): the raw capture text plus a small slice of the learner's
// existing recall (retrieve-before-generate) in, a validated proposal generation out — or null when the
// local model is unavailable, times out, or returns output that is not parseable/valid JSON. It NEVER
// throws: Quick Capture must never fail because of the model. `modelName` records which model produced
// the generation, for the candidate's audit trail.
export type ProposalAttempt = Readonly<{ generation: ProposalGeneration; modelName: string }>;

export type ProposalProvider = (
  rawText: string,
  existing: ReadonlyArray<ExistingRecallItem>
) => Promise<ProposalAttempt | null>;

// Wrap the shared `LlmModel` seam as a proposal provider: build the prompt (including the retrieved
// "Already remembered" context so the model compares before proposing), ask for JSON mode, parse the
// reply, and validate it against the generation schema. Any failure at any step degrades to null (no
// proposal), so the caller simply shows no card and keeps the saved Timeline entry. `buildPrompt`
// defaults to the live proposal prompt; the backfill provider swaps in the high-value backfill prompt.
export function createProposalProvider(
  chat: LlmModel,
  modelName: string,
  buildPrompt: (rawText: string, existing: ReadonlyArray<ExistingRecallItem>) => string = buildProposalPrompt
): ProposalProvider {
  return async (rawText, existing) => {
    let reply: string;
    try {
      reply = await chat(buildPrompt(rawText, existing), { json: true });
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(reply);
    } catch {
      return null;
    }

    const result = proposalGenerationSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }

    return { generation: result.data, modelName };
  };
}

// The backfill proposal provider (#456): the same seam/gate/schema as live capture, but built with the
// high-value backfill prompt so mining older Timeline history prefers durable, reusable items over
// one-off spelling/product-name corrections.
export function createBackfillProposalProvider(chat: LlmModel, modelName: string): ProposalProvider {
  return createProposalProvider(chat, modelName, buildBackfillProposalPrompt);
}
