import { proposalGenerationSchema, type ProposalGeneration } from "@whetstone/contracts";
import { buildProposalPrompt } from "@whetstone/domain";

import type { LlmModel } from "../../llm/llmModel.js";

// The Make Durable proposal seam (#452): raw capture text in, a validated proposal generation out — or
// null when the local model is unavailable, times out, or returns output that is not parseable/valid
// JSON. It NEVER throws: Quick Capture must never fail because of the model. `modelName` records which
// model produced the generation, for the candidate's audit trail.
export type ProposalAttempt = Readonly<{ generation: ProposalGeneration; modelName: string }>;

export type ProposalProvider = (rawText: string) => Promise<ProposalAttempt | null>;

// Wrap the shared `LlmModel` seam as a proposal provider: build the proposal prompt, ask for JSON mode,
// parse the reply, and validate it against the generation schema. Any failure at any step degrades to
// null (no proposal), so the caller simply shows no card and keeps the saved Timeline entry.
export function createProposalProvider(chat: LlmModel, modelName: string): ProposalProvider {
  return async (rawText) => {
    let reply: string;
    try {
      reply = await chat(buildProposalPrompt(rawText), { json: true });
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
